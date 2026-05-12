const parseViewport = str => str
    ?.split(/[,;\s]/)
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#onResize())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #isPDF = false
    #wrapper
    #transform = { x: 0, y: 0, scale: 1 }
    #pdfLastRenderedScale = 1
    #pdfSettleTimeout = null
    #pdfSettleId = 0
    // Accumulate wheel deltas within a single animation frame before zooming.
    // Ratio is multiplied (not replaced) so rapid events compound correctly.
    #zoomAccum = { ratio: 1, cx: 0, cy: 0, raf: null }
    #dragState = { isDragging: false, startX: 0, startY: 0, startTX: 0, startTY: 0 }
    #pinchState = { active: false, dist: 0, cx: 0, cy: 0 }
    #panState = { active: false, startX: 0, startY: 0, startTX: 0, startTY: 0 }

    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: block;
            overflow: hidden;
            position: relative;
        }`)

        this.#wrapper = document.createElement('div')
        this.#wrapper.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            display: flex;
            transform-origin: 0 0;
        `
        this.#root.appendChild(this.#wrapper)
        this.#observer.observe(this)

        this.addEventListener('wheel', e => this.#handleWheel(e), { passive: false })
        this.addEventListener('mousedown', e => this.#handleMouseDown(e))
        this.addEventListener('mousemove', e => this.#handleMouseMove(e))
        this.addEventListener('mouseup', () => this.#handleMouseUp())
        this.addEventListener('mouseleave', () => this.#handleMouseUp())
        this.addEventListener('touchstart', e => this.#handleTouchStart(e), { passive: false })
        this.addEventListener('touchmove', e => this.#handleTouchMove(e), { passive: false })
        this.addEventListener('touchend', e => this.#handleTouchEnd(e))
    }

    attributeChangedCallback(name, _, value) {
        if (name !== 'zoom') return
        if (value == null) {
            this.#zoom = undefined
            this.#render()
            return
        }
        if (value === 'fit-width' || value === 'fit-page') {
            this.#zoom = value
            this.#render()
            return
        }
        const n = parseFloat(value)
        if (!isNaN(n)) {
            const rect = this.getBoundingClientRect()
            this.#zoomByRatio(rect.width / 2, rect.height / 2, n / this.#transform.scale)
        }
    }

    get currentScale() {
        return this.#transform.scale
    }

    // Replaces scrollLeft-based edge detection now that the host uses overflow:hidden.
    // Returns whether the panned content is flush with the left/right edge of the viewport.
    get scrollEdge() {
        const { contentWidth } = this.#getContentSize()
        const { width } = this.getBoundingClientRect()
        if (contentWidth <= width) return { atLeft: true, atRight: true }
        return {
            atLeft: this.#transform.x >= -1,
            atRight: this.#transform.x <= width - contentWidth + 1,
        }
    }

    #onResize() {
        clearTimeout(this.#pdfSettleTimeout)
        if (typeof this.#zoom === 'number' && !isNaN(this.#zoom)) {
            this.#updateFrameScales(this.#transform.scale)
            this.#clampTransform()
            this.#applyTransform()
        } else {
            this.#render()
        }
    }

    #applyTransform() {
        this.#wrapper.style.transform = `translate(${this.#transform.x}px, ${this.#transform.y}px)`
    }

    // Enforce pan bounds: content that fits is centered; content that overflows
    // can be panned to show any edge but not dragged off-screen entirely.
    #clampTransform() {
        const { width, height } = this.getBoundingClientRect()
        const { contentWidth, contentHeight } = this.#getContentSize()
        if (contentWidth <= width) {
            this.#transform.x = (width - contentWidth) / 2
        } else {
            this.#transform.x = Math.max(width - contentWidth, Math.min(0, this.#transform.x))
        }
        if (contentHeight <= height) {
            this.#transform.y = (height - contentHeight) / 2
        } else {
            this.#transform.y = Math.max(height - contentHeight, Math.min(0, this.#transform.y))
        }
    }

    #getContentSize() {
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait' && height > width
        const target = this.#side === 'left' ? left : right
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0
        const scale = this.#transform.scale

        if (this.#center || portrait) {
            return {
                contentWidth: (target.width ?? blankWidth) * scale,
                contentHeight: (target.height ?? blankHeight) * scale,
            }
        }
        return {
            contentWidth: ((left.width ?? blankWidth) + (right.width ?? blankWidth)) * scale,
            contentHeight: Math.max(left.height ?? blankHeight, right.height ?? blankHeight) * scale,
        }
    }

    #updateFrameScales(scale) {
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait' && height > width
        const target = this.#side === 'left' ? left : right
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const applyToFrame = frame => {
            const { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) onZoom({ doc: iframe.contentDocument, scale })
            Object.assign(iframe.style, {
                width: `${width * (onZoom ? scale : 1)}px`,
                height: `${height * (onZoom ? scale : 1)}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: (portrait && frame !== target) ? 'none' : 'block',
                flexShrink: '0',
            })
        }

        if (this.#center) applyToFrame(this.#center)
        else { applyToFrame(left); applyToFrame(right) }

        if (this.#isPDF) this.#pdfLastRenderedScale = scale
    }

    // During a PDF zoom gesture, scale the already-rendered canvas with CSS transform
    // for instant visual feedback. The real pdfjs render fires after settling.
    #applyPDFZoomScale(scale) {
        const cssScale = scale / this.#pdfLastRenderedScale
        const frames = this.#center ? [this.#center] : [this.#left, this.#right]
        for (const frame of frames) {
            if (!frame?.onZoom || !frame.iframe) continue
            Object.assign(frame.iframe.style, {
                width: `${frame.width * this.#pdfLastRenderedScale}px`,
                height: `${frame.height * this.#pdfLastRenderedScale}px`,
                transform: `scale(${cssScale})`,
                transformOrigin: 'top left',
            })
            Object.assign(frame.element.style, {
                width: `${frame.width * scale}px`,
                height: `${frame.height * scale}px`,
            })
        }
    }

    #schedulePDFRerender(scale) {
        clearTimeout(this.#pdfSettleTimeout)
        const settleId = ++this.#pdfSettleId
        this.#pdfSettleTimeout = setTimeout(async () => {
            const frames = (this.#center ? [this.#center] : [this.#left, this.#right])
                .filter(f => f?.onZoom && f.iframe?.isConnected)
            // onCanvasReady fires synchronously inside onZoom, immediately after
            // replaceChildren puts the new canvas in the iframe — and before any
            // await yields to the browser. Swapping the CSS transform here means
            // the browser never sees a frame where the new canvas has the old scale.
            // The settleId guard discards callbacks from stale settles that were
            // superseded by a newer zoom gesture before they completed.
            const swapFrame = frame => {
                if (this.#pdfSettleId !== settleId) return
                if (!frame.iframe?.isConnected) return
                const w = frame.width * scale
                const h = frame.height * scale
                Object.assign(frame.iframe.style, {
                    width: `${w}px`,
                    height: `${h}px`,
                    transform: 'none',
                    transformOrigin: 'top left',
                })
                Object.assign(frame.element.style, {
                    width: `${w}px`,
                    height: `${h}px`,
                })
            }
            await Promise.all(frames.map(frame =>
                frame.onZoom({
                    doc: frame.iframe.contentDocument,
                    scale,
                    onCanvasReady: () => swapFrame(frame),
                })
            ))
            if (this.#pdfSettleId === settleId) {
                this.#pdfLastRenderedScale = scale
                this.#pdfSettleTimeout = null
            }
        }, 300)
    }

    #zoomByRatio(cx, cy, ratio) {
        if (!ratio || !isFinite(ratio)) return
        const MIN_SCALE = 0.1
        const MAX_SCALE = 10
        const { width, height } = this.getBoundingClientRect()
        cx = Math.max(0, Math.min(width, cx))
        cy = Math.max(0, Math.min(height, cy))
        const oldScale = this.#transform.scale
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale * ratio))
        const actualRatio = newScale / oldScale

        this.#transform.x = cx - actualRatio * (cx - this.#transform.x)
        this.#transform.y = cy - actualRatio * (cy - this.#transform.y)
        this.#transform.scale = newScale
        this.#zoom = newScale

        if (this.#isPDF) {
            this.#applyPDFZoomScale(newScale)
            this.#schedulePDFRerender(newScale)
        } else {
            this.#updateFrameScales(newScale)
        }
        this.#clampTransform()
        this.#applyTransform()
        this.dispatchEvent(new CustomEvent('zoom', { detail: { scale: newScale } }))
    }

    #handleWheel(event) {
        event.preventDefault()
        const rect = this.getBoundingClientRect()
        this.#zoomAccum.cx = event.clientX - rect.left
        this.#zoomAccum.cy = event.clientY - rect.top
        this.#zoomAccum.ratio *= event.deltaY > 0 ? 1 - 0.05 : 1 + 0.05

        if (!this.#zoomAccum.raf) {
            this.#zoomAccum.raf = requestAnimationFrame(() => {
                this.#zoomByRatio(this.#zoomAccum.cx, this.#zoomAccum.cy, this.#zoomAccum.ratio)
                this.#zoomAccum.ratio = 1
                this.#zoomAccum.raf = null
            })
        }
    }

    // Mouse drag only activates when content is explicitly zoomed (numeric zoom).
    // At fit-page/fit-width the content fits, so there's nothing to pan.
    #contentOverflows() {
        const { contentWidth, contentHeight } = this.#getContentSize()
        const { width, height } = this.getBoundingClientRect()
        return contentWidth > width || contentHeight > height
    }

    #handleMouseDown(event) {
        if (event.button !== 0 || !this.#contentOverflows()) return
        this.#dragState.isDragging = true
        this.#dragState.startX = event.clientX
        this.#dragState.startY = event.clientY
        this.#dragState.startTX = this.#transform.x
        this.#dragState.startTY = this.#transform.y
        this.style.cursor = 'grabbing'
        event.preventDefault()
    }

    #handleMouseMove(event) {
        if (!this.#dragState.isDragging) return
        this.#transform.x = this.#dragState.startTX + (event.clientX - this.#dragState.startX)
        this.#transform.y = this.#dragState.startTY + (event.clientY - this.#dragState.startY)
        this.#clampTransform()
        this.#applyTransform()
    }

    #handleMouseUp() {
        if (!this.#dragState.isDragging) return
        this.#dragState.isDragging = false
        this.style.cursor = ''
    }

    #handleTouchStart(event) {
        if (event.touches.length === 2) {
            this.#pinchState.active = true
            this.#panState.active = false
            const [t0, t1] = event.touches
            const rect = this.getBoundingClientRect()
            this.#pinchState.dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
            this.#pinchState.cx = (t0.clientX + t1.clientX) / 2 - rect.left
            this.#pinchState.cy = (t0.clientY + t1.clientY) / 2 - rect.top
            event.preventDefault()
        } else if (event.touches.length === 1) {
            this.#pinchState.active = false
            if (this.#contentOverflows()) {
                const t = event.touches[0]
                const rect = this.getBoundingClientRect()
                this.#panState.active = false
                this.#panState.startX = t.clientX - rect.left
                this.#panState.startY = t.clientY - rect.top
                this.#panState.startTX = this.#transform.x
                this.#panState.startTY = this.#transform.y
            }
        } else {
            this.#pinchState.active = false
        }
    }

    #handleTouchMove(event) {
        if (this.#pinchState.active && event.touches.length === 2) {
            const [t0, t1] = event.touches
            const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
            if (!this.#pinchState.dist || !newDist) return
            const rect = this.getBoundingClientRect()
            this.#pinchState.cx = (t0.clientX + t1.clientX) / 2 - rect.left
            this.#pinchState.cy = (t0.clientY + t1.clientY) / 2 - rect.top
            this.#zoomByRatio(this.#pinchState.cx, this.#pinchState.cy, newDist / this.#pinchState.dist)
            this.#pinchState.dist = newDist
            event.preventDefault()
        } else if (!this.#pinchState.active && event.touches.length === 1 && this.#contentOverflows()) {
            const t = event.touches[0]
            const rect = this.getBoundingClientRect()
            this.#transform.x = this.#panState.startTX + (t.clientX - rect.left - this.#panState.startX)
            this.#transform.y = this.#panState.startTY + (t.clientY - rect.top - this.#panState.startY)
            this.#panState.active = true
            this.#clampTransform()
            this.#applyTransform()
            event.preventDefault()
        }
    }

    #handleTouchEnd(event) {
        if (event.touches.length < 2) this.#pinchState.active = false
        if (event.touches.length === 0) this.#panState.active = false
    }

    // Proxy wheel, mouse, and touch events from inside iframes to the host handlers.
    // Required because iframe documents are separate browsing contexts and their
    // events don't reach the host shadow root on their own.
    #attachIframeEvents(doc, frame) {
        const toHostCoords = event => {
            const ir = frame.iframe.getBoundingClientRect()
            const hr = this.getBoundingClientRect()
            const sx = ir.width / (doc.documentElement.clientWidth || 1)
            const sy = ir.height / (doc.documentElement.clientHeight || 1)
            return {
                clientX: ir.left - hr.left + event.clientX * sx,
                clientY: ir.top - hr.top + event.clientY * sy,
            }
        }

        const toPinchCoords = touches => {
            const ir = frame.iframe.getBoundingClientRect()
            const hr = this.getBoundingClientRect()
            const sx = ir.width / (doc.documentElement.clientWidth || 1)
            const sy = ir.height / (doc.documentElement.clientHeight || 1)
            return Array.from(touches).map(t => ({
                clientX: ir.left - hr.left + t.clientX * sx,
                clientY: ir.top - hr.top + t.clientY * sy,
            }))
        }

        doc.addEventListener('wheel', event => {
            const { clientX, clientY } = toHostCoords(event)
            this.#zoomAccum.cx = clientX
            this.#zoomAccum.cy = clientY
            this.#zoomAccum.ratio *= event.deltaY > 0 ? 1 - 0.05 : 1 + 0.05
            if (!this.#zoomAccum.raf) {
                this.#zoomAccum.raf = requestAnimationFrame(() => {
                    this.#zoomByRatio(this.#zoomAccum.cx, this.#zoomAccum.cy, this.#zoomAccum.ratio)
                    this.#zoomAccum.ratio = 1
                    this.#zoomAccum.raf = null
                })
            }
            event.preventDefault()
            event.stopPropagation()
        }, { passive: false })

        doc.addEventListener('mousedown', event => {
            if (!this.#contentOverflows()) return
            const { clientX, clientY } = toHostCoords(event)
            this.#dragState.isDragging = true
            this.#dragState.startX = clientX
            this.#dragState.startY = clientY
            this.#dragState.startTX = this.#transform.x
            this.#dragState.startTY = this.#transform.y
            this.style.cursor = 'grabbing'
            event.preventDefault()
        })

        doc.addEventListener('mousemove', event => {
            if (!this.#dragState.isDragging) return
            const { clientX, clientY } = toHostCoords(event)
            this.#transform.x = this.#dragState.startTX + (clientX - this.#dragState.startX)
            this.#transform.y = this.#dragState.startTY + (clientY - this.#dragState.startY)
            this.#clampTransform()
            this.#applyTransform()
        })

        doc.addEventListener('mouseup', () => this.#handleMouseUp())

        doc.addEventListener('touchstart', event => {
            if (event.touches.length === 2) {
                this.#pinchState.active = true
                this.#panState.active = false
                const [p0, p1] = toPinchCoords(event.touches)
                this.#pinchState.dist = Math.hypot(p1.clientX - p0.clientX, p1.clientY - p0.clientY)
                this.#pinchState.cx = (p0.clientX + p1.clientX) / 2
                this.#pinchState.cy = (p0.clientY + p1.clientY) / 2
                event.preventDefault()
            } else if (event.touches.length === 1 && this.#contentOverflows()) {
                this.#pinchState.active = false
                const { clientX, clientY } = toHostCoords(event.touches[0])
                this.#panState.active = false
                this.#panState.startX = clientX
                this.#panState.startY = clientY
                this.#panState.startTX = this.#transform.x
                this.#panState.startTY = this.#transform.y
            } else {
                this.#pinchState.active = false
            }
        }, { passive: false })

        doc.addEventListener('touchmove', event => {
            if (this.#pinchState.active && event.touches.length === 2) {
                const [p0, p1] = toPinchCoords(event.touches)
                const newDist = Math.hypot(p1.clientX - p0.clientX, p1.clientY - p0.clientY)
                if (!this.#pinchState.dist || !newDist) return
                this.#pinchState.cx = (p0.clientX + p1.clientX) / 2
                this.#pinchState.cy = (p0.clientY + p1.clientY) / 2
                this.#zoomByRatio(this.#pinchState.cx, this.#pinchState.cy, newDist / this.#pinchState.dist)
                this.#pinchState.dist = newDist
                event.preventDefault()
            } else if (!this.#pinchState.active && event.touches.length === 1 && this.#contentOverflows()) {
                const { clientX, clientY } = toHostCoords(event.touches[0])
                this.#transform.x = this.#panState.startTX + (clientX - this.#panState.startX)
                this.#transform.y = this.#panState.startTY + (clientY - this.#panState.startY)
                this.#panState.active = true
                this.#clampTransform()
                this.#applyTransform()
                event.preventDefault()
            }
        }, { passive: false })

        doc.addEventListener('touchend', event => {
            if (event.touches.length < 2) this.#pinchState.active = false
            if (event.touches.length === 0) this.#panState.active = false
        })
    }

    #render(side = this.#side) {
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait' && height > width
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1

        this.#transform.scale = scale
        this.#updateFrameScales(scale)

        const { contentWidth, contentHeight } = this.#getContentSize()
        const isNumericZoom = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
        const hasDualFrames = !this.#center && !this.#left?.blank && !this.#right?.blank

        // For numeric zoom with two visible frames, center the active page rather
        // than the full spread (the other page sits off to the side for panning).
        if (isNumericZoom && hasDualFrames && !portrait) {
            const leftWidth = (left.width ?? 0) * scale
            const rightWidth = (right.width ?? 0) * scale
            this.#transform.x = side === 'right'
                ? (width - rightWidth) / 2 - leftWidth
                : (width - leftWidth) / 2
        } else {
            this.#transform.x = (width - contentWidth) / 2
        }

        // Vertically: show the top of the page if it overflows, center if it fits.
        this.#transform.y = contentHeight > height ? 0 : (height - contentHeight) / 2
        this.#applyTransform()
    }

    async #createFrame({ index, src: srcOption }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#wrapper.append(element)
        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                const frame = {
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                }
                this.#attachIframeEvents(doc, frame)
                resolve(frame)
            }, { once: true })
            iframe.src = src
        })
    }

    async #showSpread({ left, right, center, side }) {
        clearTimeout(this.#pdfSettleTimeout)
        this.#wrapper.replaceChildren()
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            this.#isPDF = !!this.#center?.onZoom
            this.#render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = this.#left.blank ? 'right'
                : this.#right.blank ? 'left' : side
            this.#isPDF = !!(this.#left?.onZoom || this.#right?.onZoom)
            this.#render()
        }
    }

    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
        // Numeric zoom + dual frames: pan to show the left page before leaving spread.
        if (typeof this.#zoom === 'number' && !isNaN(this.#zoom) && !this.#right?.blank) {
            if (this.#side === 'right') {
                this.#side = 'left'
                this.#render()
                return true
            }
        }
    }

    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
        // Numeric zoom + dual frames: pan to show the right page before leaving spread.
        if (typeof this.#zoom === 'number' && !isNaN(this.#zoom) && !this.#left?.blank) {
            if (this.#side === 'left') {
                this.#side = 'right'
                this.#render()
                return true
            }
        }
    }

    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }

    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }

    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }

    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }

    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#render(side)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#showSpread({ left, right, side })
        }
        this.#reportLocation(reason)
    }

    async reload() {
        const idx = this.#index
        if (idx < 0) return
        this.#index = -1
        await this.goToSpread(idx, this.#side ?? 'center')
    }

    async select(target) {
        await this.goTo(target)
        // TODO
    }

    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }

    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }

    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }

    getContents() {
        return Array.from(this.#root.querySelectorAll('iframe'), frame => ({
            doc: frame.contentDocument,
            // TODO: index, overlayer
        }))
    }

    destroy() {
        this.#observer.unobserve(this)
        clearTimeout(this.#pdfSettleTimeout)
        if (this.#zoomAccum.raf) {
            cancelAnimationFrame(this.#zoomAccum.raf)
            this.#zoomAccum.raf = null
        }
    }
}

customElements.define('foliate-fxl', FixedLayout)
