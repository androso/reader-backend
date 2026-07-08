import createDOMPurify from "dompurify";
import type { TextBlock } from "./types";

const ALLOWED_HTML_TAGS = [
    "a",
    "abbr",
    "article",
    "aside",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "dd",
    "del",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "i",
    "img",
    "ins",
    "li",
    "main",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
].sort();

const ALLOWED_HTML_ATTRIBUTES = [
    "alt",
    "aria-label",
    "aria-labelledby",
    "class",
    "colspan",
    "height",
    "href",
    "id",
    "lang",
    "name",
    "rel",
    "role",
    "rowspan",
    "src",
    "title",
    "width",
].sort();

const SAFE_URL_PATTERN =
    /^(?:(?:https?|mailto|tel|blob):|data:image\/(?:png|gif|jpe?g|webp);|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const READABLE_BLOCK_SELECTOR = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "li",
    "dt",
    "dd",
    "figcaption",
    "caption",
    "th",
    "td",
].join(",");

const CONTAINER_SELECTOR = [
    "body",
    "main",
    "article",
    "section",
    "div",
    "aside",
    "header",
    "footer",
].join(",");

const SKIPPED_SELECTOR = "script,style,link,meta,title";

const getPurifierWindow = (doc: Document) => {
    if (doc.defaultView) return doc.defaultView;
    if (typeof window !== "undefined") return window;
    throw new Error("A DOM window is required to sanitize EPUB HTML");
};

export const sanitizeEpubHtml = (html: string, doc: Document): string => {
    const purify = createDOMPurify(getPurifierWindow(doc));

    return purify.sanitize(html, {
        ALLOW_ARIA_ATTR: true,
        ALLOW_DATA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        ALLOWED_ATTR: ALLOWED_HTML_ATTRIBUTES,
        ALLOWED_TAGS: ALLOWED_HTML_TAGS,
        ALLOWED_URI_REGEXP: SAFE_URL_PATTERN,
        FORBID_ATTR: ["style"],
        FORBID_TAGS: [
            "annotation-xml",
            "canvas",
            "embed",
            "foreignObject",
            "iframe",
            "math",
            "mtext",
            "noembed",
            "noframes",
            "noscript",
            "object",
            "script",
            "style",
            "svg",
            "template",
        ],
        USE_PROFILES: { html: true },
    });
};

const hasRenderableContent = (element: Element): boolean => {
    const hasText = Boolean(element.textContent?.replace(/\s+/g, " ").trim());
    const hasMedia = Boolean(
        element.querySelector("img,svg,math,table,figure,canvas")
    );

    return hasText || hasMedia;
};

const hasNestedReadableBlock = (element: Element): boolean =>
    Boolean(element.querySelector(READABLE_BLOCK_SELECTOR));

const hasRenderableHtml = (html: string, doc: Document): boolean => {
    const blockElement = doc.createElement("div");
    blockElement.innerHTML = html;
    return hasRenderableContent(blockElement);
};

const collectReadableBlocks = (element: Element): Element[] => {
    if (element.matches(SKIPPED_SELECTOR) || !hasRenderableContent(element)) {
        return [];
    }

    if (element.matches(READABLE_BLOCK_SELECTOR)) {
        return [element];
    }

    const childBlocks = Array.from(element.children).flatMap((child) =>
        collectReadableBlocks(child)
    );
    if (childBlocks.length > 0) {
        return childBlocks;
    }

    if (
        element.matches(CONTAINER_SELECTOR) ||
        !hasNestedReadableBlock(element)
    ) {
        return [element];
    }

    return [];
};

export const getReadableBlockElements = (doc: Document): Element[] =>
    Array.from(doc.body.children).flatMap((child) =>
        collectReadableBlocks(child)
    );

export const buildTextBlocksFromDocument = (
    doc: Document,
    chapterId: string
): TextBlock[] =>
    getReadableBlockElements(doc)
        .map((element) => sanitizeEpubHtml(element.outerHTML, doc))
        .filter((content) => hasRenderableHtml(content, doc))
        .map((content, index) => {
            const blockElement = doc.createElement("div");
            blockElement.innerHTML = content;

            return {
                id: `${chapterId}-block-${index}`,
                content,
                element: blockElement,
            };
        });
