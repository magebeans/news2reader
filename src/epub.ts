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

interface MathDelimiters {
  inlineMath: string[][];
  displayMath: string[][];
}

const SAFE_MATH_DELIMITERS: MathDelimiters = {
  inlineMath: [['\\(', '\\)']],
  displayMath: [['\\[', '\\]']],
};

function unescapeJSString(s: string): string {
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s;
  }
}

function extractDelimiterPairs(scriptText: string, key: string): string[][] | null {
  const keyRe = new RegExp(key + '\\s*:\\s*\\[');
  const keyMatch = keyRe.exec(scriptText);
  if (!keyMatch) return null;

  let depth = 0;
  const start = keyMatch.index + keyMatch[0].length - 1;
  let end = start;
  for (let i = start; i < scriptText.length; i++) {
    if (scriptText[i] === '[') depth++;
    else if (scriptText[i] === ']') depth--;
    if (depth === 0) { end = i; break; }
  }

  const arrayText = scriptText.slice(start, end + 1);
  const pairRe = /\[\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\]/g;
  const pairs: string[][] = [];
  let m;
  while ((m = pairRe.exec(arrayText)) !== null) {
    const left = unescapeJSString(m[1] ?? m[2]);
    const right = unescapeJSString(m[3] ?? m[4]);
    pairs.push([left, right]);
  }

  return pairs.length > 0 ? pairs : null;
}

function extractKaTeXDelimiters(scriptText: string): MathDelimiters | null {
  const delimMatch = scriptText.match(/delimiters\s*:\s*\[/);
  if (!delimMatch) return null;

  let depth = 0;
  const start = delimMatch.index! + delimMatch[0].length - 1;
  let end = start;
  for (let i = start; i < scriptText.length; i++) {
    if (scriptText[i] === '[') depth++;
    else if (scriptText[i] === ']') depth--;
    if (depth === 0) { end = i; break; }
  }

  const arrayText = scriptText.slice(start, end + 1);
  const inlineMath: string[][] = [];
  const displayMath: string[][] = [];

  const entryRe = /\{([^}]+)\}/g;
  let m;
  while ((m = entryRe.exec(arrayText)) !== null) {
    const entry = m[1];
    const leftM = entry.match(/left\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
    const rightM = entry.match(/right\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
    const dispM = entry.match(/display\s*:\s*(true|false)/);
    if (leftM && rightM) {
      const left = unescapeJSString(leftM[1] ?? leftM[2]);
      const right = unescapeJSString(rightM[1] ?? rightM[2]);
      const isDisplay = dispM ? dispM[1] === 'true' : false;
      (isDisplay ? displayMath : inlineMath).push([left, right]);
    }
  }

  if (inlineMath.length === 0 && displayMath.length === 0) return null;
  return { inlineMath, displayMath };
}

function extractMathDelimiters(html: string): MathDelimiters | null {
  const hasMathJax = /<script[^>]*mathjax/i.test(html)
    || /\bMathJax\s*=\s*\{/.test(html)
    || /MathJax\.Hub\.Config/i.test(html);
  const hasKaTeX = /<script[^>]*katex/i.test(html)
    || /\brenderMathInElement\b/.test(html);

  if (!hasMathJax && !hasKaTeX) return null;

  const scriptContents: string[] = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    if (sm[1].trim()) scriptContents.push(sm[1]);
  }
  const scriptText = scriptContents.join('\n');

  const inlineMath = extractDelimiterPairs(scriptText, 'inlineMath');
  const displayMath = extractDelimiterPairs(scriptText, 'displayMath');

  if (inlineMath || displayMath) {
    return {
      inlineMath: inlineMath || SAFE_MATH_DELIMITERS.inlineMath,
      displayMath: displayMath || SAFE_MATH_DELIMITERS.displayMath,
    };
  }

  if (hasKaTeX) {
    const katexDelims = extractKaTeXDelimiters(scriptText);
    if (katexDelims) return katexDelims;
  }

  return SAFE_MATH_DELIMITERS;
}

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
      headers: HEADERS,
      responseType: "buffer",
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
  const rawContentType = response.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType.join(", ") : rawContentType;
  console.log(`Fetched ${response.body.length} bytes from ${url} in ${Date.now() - fetchStart}ms (status ${response.statusCode}, content-type: ${contentType ?? "unknown"})`);

  // PDF: write directly to a temp file and return it as-is
  if (contentType && contentType.startsWith("application/pdf")) {
    const pdfPath = "/tmp/news2opds-out.pdf";
    writeFileSync(pdfPath, response.body);
    console.log(`PDF saved to ${pdfPath}`);
    return pdfPath;
  }

  // Bail out for other non-HTML content types
  if (contentType && !contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml")) {
    throw new UpstreamError(`Cannot convert non-HTML content to EPUB (content-type: ${contentType})`, 422);
  }

  const body = response.body.toString("utf-8");
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

  // --- Detect math config and optionally pre-render equations to SVG ---
  const mathDelimiters = extractMathDelimiters(body);
  const mathDir = join(tmpdir(), 'news2reader-math');
  mkdirSync(mathDir, { recursive: true });
  let mathIndex = 0;
  let processedContent = article.content;

  if (mathDelimiters) {
    console.log('Detected math delimiters:', JSON.stringify(mathDelimiters));
    const tex = new TeX({
      packages: AllPackages,
      inlineMath: mathDelimiters.inlineMath,
      displayMath: mathDelimiters.displayMath,
    });
    const svg = new SVG({ fontCache: 'none' });
    const mjDocument = mathjax.document(processedContent, {
      InputJax: tex,
      OutputJax: svg,
    });

    mjDocument.render();

    processedContent = mathjaxAdaptor.innerHTML(mathjaxAdaptor.body(mjDocument.document));

    // Write each MathJax SVG to a temp file and reference via file:// URL.
    // - E-readers strip custom elements like <mjx-container>
    // - Inline <svg> isn't valid in XHTML 1.1 (epub-gen's default doctype)
    // - epub-gen copies file:// images into the EPUB package
    processedContent = processedContent.replace(
      /<mjx-container([^>]*)>([\s\S]*?)<\/mjx-container>/g,
      (_match: string, attrs: string, inner: string) => {
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
        if (attrs.includes('display="true"')) {
          return `<div style="text-align: center; margin: 1em 0;">${img}</div>`;
        }
        return img;
      }
    );
  } else {
    console.log('No math configuration detected, skipping MathJax processing');
  }

  // Convert data: URI images to temp files. epub-gen doesn't handle data URIs —
  // it tries to use them as file paths, causing ENAMETOOLONG / ENOENT errors.
  processedContent = processedContent.replace(
    /(<img\b[^>]*\bsrc=")data:image\/([^;]+);base64,([^"]+)("[^>]*>)/gi,
    (_match: string, before: string, ext: string, b64: string, after: string) => {
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
