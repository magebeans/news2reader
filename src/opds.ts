import querystring from "node:querystring";
import { create } from "xmlbuilder2";
import { XMLBuilder } from "xmlbuilder2/lib/interfaces";
import { nameFromUrlPath } from "./util.js";

const LINK_TYPE_NAVIGATION = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const LINK_TYPE_SEARCH = 'application/opensearchdescription+xml';

interface FeedProperties {
    id: string;
    links: { self: string; start: string; up?: string; search?: string };
    title: string;
    author?: { name: string; uri: string };
}
interface SubsectionEntryProperties {
    id: string,
    title: string,
    link: string,
    content: string,
}

export class OPDSFeed {
    feed: XMLBuilder;
    constructor(properties: FeedProperties) {
        const now = (new Date()).toISOString();
        this.feed = create()
        .ele('feed', { xmlns: "http://www.w3.org/2005/Atom" })
        .ele('id').txt(properties.id).up()
        .ele('title').txt(properties.title).up()
        .ele('updated').txt(now).up()
        .ele('link', { rel: 'self', href: properties.links.self, type: LINK_TYPE_NAVIGATION }).up()
        .ele('link', { rel: 'start', href: properties.links.start, type: LINK_TYPE_NAVIGATION }).up();

        if (properties.links.up) {
            this.feed.ele('link', { rel: 'up', href: properties.links.up, type: LINK_TYPE_NAVIGATION }).up();
        }

        if (properties.links.search) {
            this.feed.ele('link', { rel: 'search', href: properties.links.search, type: LINK_TYPE_SEARCH }).up();
        }

        if (typeof properties.author !== "undefined") {
            this.feed.ele('author')
            .ele('name').txt(properties.author.name).up()
            .ele('uri').txt(properties.author.uri).up()
          .up();
        }
    }
    addEntry(properties: SubsectionEntryProperties) {
        this.feed.ele('entry')
        .ele('id').txt(properties.id).up()
        .ele('title').txt(properties.title).up()
        .ele('link', { rel: 'subsection', href: properties.link, type: LINK_TYPE_NAVIGATION }).up()
        //.ele('updated').txt('2023-07-27T07:26:26.954Z').up()
        .ele('content', {type: 'text'}).txt(properties.content).up();
    }
    addEntries(entries: SubsectionEntryProperties[]) {
        for (const entry of entries) {
            this.addEntry(entry);
        }
    }
    addArticleAcquisitionEntry(url: string, title: string, summary?: string, updated?: string) {
      // URL param is base64-encoded for the EPUB conversion link,
      // to avoid misleading clients trying to detect type based on suffixes in that specific case.
      const queryString = querystring.stringify({ url: Buffer.from(url).toString('base64') });

      // Default to EPUB conversion path and type
      let finalHref = `/content.epub?${queryString}`;
      let finalType = "application/epub+zip";

      const parsedUrl = new URL(url);
      const pathnameLower = parsedUrl.pathname.toLowerCase();

      if (pathnameLower.endsWith(".pdf")) {
        finalHref = url;
        finalType = "application/pdf";
      } else if (pathnameLower.endsWith(".epub")) {
        finalHref = url;
        finalType = "application/epub+zip";
      }

      // Title cleanup
      let finalTitle = title.trim();
      if (finalTitle === "") {
        finalTitle = nameFromUrlPath(url);
      }

      const entryId = Buffer.from(url).toString('base64url');

      const entry = this.feed.ele("entry")
        .ele("id").txt(entryId).up()
        .ele("title").txt(finalTitle).up();

      if (updated) {
        entry.ele('updated').txt(updated).up();
      }

      entry.ele("link", {
          rel: "http://opds-spec.org/acquisition",
          href: finalHref,
          type: finalType,
        }).up();

      if (summary && summary.trim() !== "") {
        entry.ele('summary', {type: 'text'}).txt(summary.trim()).up();
      }
    }
    toXmlString() {
        return this.feed.doc().end({ prettyPrint: true });
    }
}
