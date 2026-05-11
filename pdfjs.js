// Vite-compatible entry point that sets up pdfjsLib for use outside of pdf.js
// (e.g. metadata extraction at import time). Imports the vendored pdfjs,
// configures the worker, and exports pdfjsLib for consumers.
import './vendor/pdfjs/pdf.mjs'
export const pdfjsLib = globalThis.pdfjsLib
import pdfjsWorkerUrl from './vendor/pdfjs/pdf.worker.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl
