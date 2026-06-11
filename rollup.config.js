import { nodeResolve } from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import { copy } from 'fs-extra'
import { readFileSync, writeFileSync } from 'fs'

// Utility functions injected into pdfjs files to replace Node.js-only Uint8Array methods.
const PATCH_UTILS = `// -- OffReader patch: polyfills for Node.js-only Uint8Array methods --
function bytesToHex(bytes){return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("")}
function bytesToBase64(bytes){let s="";for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return btoa(s)}
function base64ToBytes(str){return Uint8Array.from(atob(str),c=>c.charCodeAt(0))}
// -- end OffReader patch --
`

const copyAndPatchPDFJS = () => ({
    name: 'copy-and-patch-pdfjs',
    async writeBundle() {
        // Step 1: Copy pdfjs-dist files into vendor/
        await copy('node_modules/pdfjs-dist/build/pdf.mjs', 'vendor/pdfjs/pdf.mjs')
        await copy('node_modules/pdfjs-dist/build/pdf.mjs.map', 'vendor/pdfjs/pdf.mjs.map')
        await copy('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'vendor/pdfjs/pdf.worker.mjs')
        await copy('node_modules/pdfjs-dist/build/pdf.worker.mjs.map', 'vendor/pdfjs/pdf.worker.mjs.map')
        await copy('node_modules/pdfjs-dist/cmaps', 'vendor/pdfjs/cmaps')
        await copy('node_modules/pdfjs-dist/standard_fonts', 'vendor/pdfjs/standard_fonts')

        // Step 2: Patch non-standard Uint8Array methods (Node.js-only, not in browser/worker)
        // When updating pdfjs-dist, run `npm run build` — if any target has changed,
        // the build fails with a clear error showing which string wasn't found.
        const patches = [
            {
                file: 'vendor/pdfjs/pdf.worker.mjs',
                replacements: [
                    {
                        from: 'hashOriginal.toHex(), hashModified?.toHex() ?? null',
                        to: 'bytesToHex(hashOriginal), hashModified ? bytesToHex(hashModified) : null',
                    },
                    {
                        from: 'Uint8Array.fromBase64(this[$content])',
                        to: 'base64ToBytes(this[$content])',
                    },
                ],
            },
            {
                file: 'vendor/pdfjs/pdf.mjs',
                replacements: [
                    {
                        from: 'this.data.toBase64()',
                        to: 'bytesToBase64(this.data)',
                    },
                    {
                        from: 'return bytes.toBase64()',
                        to: 'return bytesToBase64(bytes)',
                    },
                    {
                        from: 'Uint8Array.fromBase64(signatureData)',
                        to: 'base64ToBytes(signatureData)',
                    },
                ],
            },
        ]

        for (const { file, replacements } of patches) {
            let content = readFileSync(file, 'utf-8')

            for (const { from, to } of replacements) {
                if (!content.includes(from)) {
                    throw new Error(
                        `[patch-pdfjs] Patch target not found in ${file}:\n  ${from}\n\n` +
                        'This usually means pdfjs-dist has been updated and the code has changed.\n' +
                        'Update the replacement strings in rollup.config.js to match the new source.'
                    )
                }
                content = content.replace(from, to)
            }

            // Inject utility functions at the top of the file
            content = PATCH_UTILS + content

            writeFileSync(file, content)
            console.log(`[patch-pdfjs] Patched ${file} (${replacements.length} replacements)`)
        }
    },
})

export default [{
    input: 'rollup/fflate.js',
    output: {
        dir: 'vendor/',
        format: 'esm',
    },
    plugins: [nodeResolve(), terser()],
},
{
    input: 'rollup/zip.js',
    output: {
        dir: 'vendor/',
        format: 'esm',
    },
    plugins: [nodeResolve(), terser(), copyAndPatchPDFJS()],
}]
