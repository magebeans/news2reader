import { tmpdir } from "node:os";
import { URL, fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import Epub from "epub-gen";
import jsdom from "jsdom";
import { Readability } from "@mozilla/readability";
import got, { HTTPError, TimeoutError, RequestError } from "got";
import { UpstreamError } from "./errors.js";
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { jsdomAdaptor } from 'mathjax-full/js/adaptors/jsdomAdaptor.js';
import { HTMLHandler } from 'mathjax-full/js/handlers/html/HTMLHandler.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

const HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.3',
};

const READABILITY_DEBUG = process.env.READABILITY_DEBUG === "1" || process.env.READABILITY_DEBUG === "true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CUSTOM_OPF_TEMPLATE = join(__dirname, "templates/content.opf.ejs");

// Initialize MathJax adaptor and handler once at module level.
// Register directly on the imported mathjax object rather than using
// RegisterHTMLHandler, which does its own CJS require("../mathjax.js")
// that may resolve to a different module instance under ESM/CJS interop.
const mathjaxAdaptor = jsdomAdaptor(jsdom.JSDOM);
mathjax.handlers.register(new HTMLHandler(mathjaxAdaptor));

export async function articleToEpub(
  url: string,
  preferredTitle: string | null
) {
  const urlObj = new URL(url);
  const urlHost = urlObj.hostname;

  // TODO: Read/write EPUB into a cache dir by URL hash
  const outputPath = "/tmp/news2opds-out.epub";
  const virtualConsole = new jsdom.VirtualConsole();
  virtualConsole.on("jsdomError", (err) => console.error("JSDOM error:", String(err).slice(0, 300)));
  virtualConsole.on("error", (err) => console.error("JSDOM console.error:", String(err).slice(0, 300)));

  console.log(`Processing article at URL ${url} to path ${outputPath}`);

  const fetchStart = Date.now();
  let response;
  try {
    response = await got(url, {
      headers: HEADERS
    });
  } catch (error) {
    const elapsed = Date.now() - fetchStart;
    if (error instanceof HTTPError) {
      const status = error.response.statusCode;
      const retryAfter = error.response.headers["retry-after"] as string | undefined;
      console.error(`Upstream returned HTTP ${status} for ${url} in ${elapsed}ms`);
      if (status === 429) {
        throw new UpstreamError(`Rate limited by upstream (${url})`, 429, retryAfter);
      } else if (status === 403) {
        throw new UpstreamError(`Forbidden by upstream (${url})`, 403);
      } else if (status === 404) {
        throw new UpstreamError(`Not found at upstream (${url})`, 404);
      } else if (status >= 500) {
        throw new UpstreamError(`Upstream server error (HTTP ${status}) for ${url}`, 502);
      } else {
        throw new UpstreamError(`Upstream error (HTTP ${status}) for ${url}`, 502);
      }
    } else if (error instanceof TimeoutError) {
      console.error(`Upstream request timed out for ${url} after ${elapsed}ms`);
      throw new UpstreamError(`Upstream request timed out (${url})`, 504);
    } else if (error instanceof RequestError) {
      console.error(`Network error fetching ${url} after ${elapsed}ms:`, error.message);
      throw new UpstreamError(`Network error fetching upstream (${url}): ${error.message}`, 504);
    }
    throw error;
  }
  const body = response.body;
  const rawContentType = response.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType.join(", ") : rawContentType;
  console.log(`Fetched ${body.length} chars from ${url} in ${Date.now() - fetchStart}ms (status ${response.statusCode}, content-type: ${contentType ?? "unknown"})`);

  // Bail out if the response is not HTML — e.g. PDF URLs without a .pdf extension
  if (contentType && !contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml")) {
    throw new UpstreamError(`Cannot convert non-HTML content to EPUB (content-type: ${contentType})`, 422);
  }
  // Create a JSDOM
  const domStart = Date.now();
  const dom = new jsdom.JSDOM(body, { url, virtualConsole });
  console.log(`Constructed JSDOM in ${Date.now() - domStart}ms`);
  if (READABILITY_DEBUG) {
    console.log("Readability debug enabled (READABILITY_DEBUG).");
  }

  // Create Readable HTML
  const readabilityStart = Date.now();
  let reader = new Readability(dom.window.document, { debug: READABILITY_DEBUG, keepClasses: READABILITY_DEBUG });
  let article: any = null;
  try {
    article = reader.parse();
  } catch (err) {
    console.error("Readability.parse() threw an exception", err);
  }
  console.log(`Readability.parse() executed in ${Date.now() - readabilityStart}ms`);
  if (article === null) {
    const doc = dom.window.document;
    const bodyTextLength = doc.body?.textContent?.length ?? 0;
    const bodyHTMLLength = doc.body?.innerHTML?.length ?? 0;
    console.error("Readability failed to parse.", {
      url,
      baseURI: doc.baseURI,
      docTitle: doc.title,
      bodyTextLength,
      bodyHTMLLength,
      articleTags: doc.getElementsByTagName("article").length,
      mainTags: doc.getElementsByTagName("main").length,
      h1Tags: doc.getElementsByTagName("h1").length,
    });
    if (process.env.VERBOSE) {
      console.error("Document head HTML length:", doc.head?.innerHTML?.length ?? 0);
      console.error("Document body HTML length:", doc.body?.innerHTML?.length ?? 0);
    } else {
      console.error("Set VERBOSE=1 to include HTML snippets in logs.");
    }
    throw new UpstreamError('Failed to parse article using Readability', 422);
  }
  console.log(`Parsed article:`, {
    title: article.title,
    byline: article.byline,
    length: article.length,
    excerpt: article.excerpt?.slice(0, 120),
  });

  // --- Pre-render MathJax equations to SVG
  const tex = new TeX({
    packages: AllPackages,
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
  });
  const svg = new SVG({ fontCache: 'none' });
  const mjDocument = mathjax.document(article.content, {
    InputJax: tex,
    OutputJax: svg,
  });

  mjDocument.render();

  let processedContent = mathjaxAdaptor.innerHTML(mathjaxAdaptor.body(mjDocument.document));

  // Write each MathJax SVG to a temp file and reference via file:// URL.
  // - E-readers strip custom elements like <mjx-container>
  // - Inline <svg> isn't valid in XHTML 1.1 (epub-gen's default doctype)
  // - epub-gen copies file:// images into the EPUB package
  const mathDir = join(tmpdir(), 'news2reader-math');
  mkdirSync(mathDir, { recursive: true });
  let mathIndex = 0;
  processedContent = processedContent.replace(
    /<mjx-container([^>]*)>([\s\S]*?)<\/mjx-container>/g,
    (_match, attrs: string, inner: string) => {
      const svgMatch = inner.match(/<svg[\s\S]*<\/svg>/);
      if (!svgMatch) return inner;
      const svgFixed = svgMatch[0].replace(/currentColor/g, '#000');
      const filename = `math-${mathIndex++}.svg`;
      writeFileSync(join(mathDir, filename), svgFixed);
      const fileUrl = `file://${join(mathDir, filename)}`;
      // Preserve vertical-align from the SVG's style for inline math baseline alignment
      const alignMatch = svgFixed.match(/vertical-align:\s*([^;"]+)/);
      const align = alignMatch ? alignMatch[1].trim() : '0';
      const img = `<img src="${fileUrl}" style="vertical-align: ${align};" alt="math"/>`;
      // Display math ($$...$$) should be block-level and centered
      if (attrs.includes('display="true"')) {
        return `<div style="text-align: center; margin: 1em 0;">${img}</div>`;
      }
      return img;
    }
  );

  // Convert data: URI images to temp files. epub-gen doesn't handle data URIs —
  // it tries to use them as file paths, causing ENAMETOOLONG / ENOENT errors.
  processedContent = processedContent.replace(
    /(<img\b[^>]*\bsrc=")data:image\/([^;]+);base64,([^"]+)("[^>]*>)/gi,
    (_match, before: string, ext: string, b64: string, after: string) => {
      const filename = `img-${mathIndex++}.${ext.toLowerCase().replace('+xml', '')}`;
      writeFileSync(join(mathDir, filename), Buffer.from(b64, 'base64'));
      return `${before}file://${join(mathDir, filename)}${after}`;
    }
  );

  // ---

  const title = preferredTitle ?? article?.title ?? "Title Missing";

  // Build the EPUB at output_path
  await new Epub({
    output: outputPath,
    title: title,
    author: article?.byline,
    publisher: urlHost,
    identifier: url,
    customOpfTemplatePath: CUSTOM_OPF_TEMPLATE,
    content: [
      {
        title: title,
        author: article?.byline,
        data: processedContent,
        beforeToc: true,
      },
    ],
    css: '',
    tempDir: tmpdir(),
  }).promise;

  console.log(`EPUB saved to ${outputPath}`);
  return outputPath;
}
