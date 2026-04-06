import { tmpdir } from "node:os";
import { URL } from "node:url";
import Epub from "epub-gen";
import jsdom from "jsdom";
import { Readability } from "@mozilla/readability";
import got from "got";
import katex from 'katex';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.3',
};

const READABILITY_DEBUG = process.env.READABILITY_DEBUG === "1" || process.env.READABILITY_DEBUG === "true";

// Load KaTeX CSS once at module scope
const require_ = createRequire(import.meta.url);
const katexCss = readFileSync(require_.resolve('katex/dist/katex.min.css'), 'utf-8');

/**
 * Find TeX delimiters in HTML and replace them with KaTeX-rendered HTML.
 * Returns the processed HTML and whether any math was found.
 */
function renderMathInHtml(html: string): { html: string; hasMath: boolean } {
  let hasMath = false;

  // Order matters: match $$ before $, and \[...\] before \(...\)
  const patterns: Array<{ regex: RegExp; displayMode: boolean }> = [
    { regex: /\$\$([\s\S]+?)\$\$/g, displayMode: true },
    { regex: /\\\[([\s\S]+?)\\\]/g, displayMode: true },
    { regex: /(?<!\$)\$(?!\$)(.+?)\$(?!\$)/g, displayMode: false },
    { regex: /\\\(([\s\S]+?)\\\)/g, displayMode: false },
  ];

  for (const { regex, displayMode } of patterns) {
    html = html.replace(regex, (_match, tex: string) => {
      hasMath = true;
      return katex.renderToString(tex, { displayMode, throwOnError: false });
    });
  }

  return { html, hasMath };
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
  const response = await got(url, {
    headers: HEADERS
  });
  const body = response.body;
  const rawContentType = response.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType.join(", ") : rawContentType;
  console.log(`Fetched ${body.length} chars from ${url} in ${Date.now() - fetchStart}ms (status ${response.statusCode}, content-type: ${contentType ?? "unknown"})`);

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
      console.error("Document head HTML (first 5000 chars):", doc.head?.innerHTML?.slice(0, 5000));
      console.error("Document body HTML (first 5000 chars):", doc.body?.innerHTML?.slice(0, 5000));
    } else {
      console.error("Set VERBOSE=1 to include HTML snippets in logs.");
    }
    throw new Error('Failed to parse article using Readability');
  }
  console.log(`Parsed article:`, {
    title: article.title,
    byline: article.byline,
    length: article.length,
    excerpt: article.excerpt?.slice(0, 120),
  });

  // --- Render TeX math expressions with KaTeX (only if present)
  const { html: processedContent, hasMath } = renderMathInHtml(article.content);
  // ---

  const title = preferredTitle ?? article?.title ?? "Title Missing";

  // Build the EPUB at output_path
  await new Epub({
    output: outputPath,
    title: title,
    author: article?.byline,
    publisher: urlHost,
    content: [
      {
        title: title,
        author: article?.byline,
        data: processedContent,
        beforeToc: true,
      },
    ],
    css: hasMath ? katexCss : '',
    tempDir: tmpdir(),
  }).promise;

  console.log(`EPUB saved to ${outputPath}`);
  return outputPath;
}
