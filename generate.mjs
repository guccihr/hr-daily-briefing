// Daily Briefing 생성기 — GitHub Actions에서 매일 실행된다 (무료).
//   뉴스   : 공개 RSS 피드에서 후보를 모으고, 실행기 안에서 돌리는 공개 모델(Ollama)이 고르고 요약한다.
//            외부 LLM API·API 키를 쓰지 않는다 (GitHub Models는 2026-07-30 종료).
//            링크와 제목은 피드에 있던 것만 쓴다 (LLM이 지어낸 기사·URL은 버린다).
//   분석   : topics.json의 실제 출처 목록을 날짜순으로 돌려 쓰고, LLM이 설명을 쓴다.
//   노동법 : laws.json에 미리 검토해 둔 조문을 날짜순으로 돌려 쓴다 (LLM이 법 내용을 쓰지 않는다).
// 실행 : (ollama serve + ollama pull 후) node generate.mjs [YYYY-MM-DD]      의존성 없음, Node 20+
//        node generate.mjs --dry   → LLM 호출 없이 피드 수집·형식만 점검
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;
const OUT = join(DIR, "briefings");
const MODEL = process.env.BRIEFING_MODEL ?? "gemma3:12b";
const ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DRY = process.argv.includes("--dry");

const FEEDS = [
  { source: "HR Dive", url: "https://www.hrdive.com/feeds/news/" },
  { source: "Retail Dive", url: "https://www.retaildive.com/feeds/news/" },
  { source: "Google News", url: "https://news.google.com/rss/search?q=luxury+retail+(employees+OR+staff+OR+hiring+OR+workforce)+when:14d&hl=en-US&gl=US&ceid=US:en" },
];

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? kstToday();
const dayNumber = Math.floor(Date.parse(date) / 86400000);
const json = (name) => JSON.parse(readFileSync(join(DIR, name), "utf8"));

// ── RSS ─────────────────────────────────────────────────────
const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ").replace(/&[lr]dquo;/g, '"').replace(/&[lr]squo;/g, "'").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

async function candidates() {
  const all = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; hr-daily-briefing)" }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = (await res.text()).match(/<item>[\s\S]*?<\/item>/g) ?? [];
      for (const item of items.slice(0, 12)) {
        const url = tag(item, "link");
        const published = Date.parse(tag(item, "pubDate"));
        if (!/^https:\/\//.test(url) || !(Date.parse(date) - published < 21 * 86400000)) continue;
        // Google News는 제목 끝에 " - 매체명"이 붙고, 실제 매체는 <source>에 있다
        const outlet = tag(item, "source");
        const title = tag(item, "title").replace(outlet ? new RegExp(`\\s+-\\s+${outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : /$^/, "");
        const description = tag(item, "description").slice(0, 300);
        // Google News는 설명이 제목의 반복이다 → 요약할 근거가 제목뿐인 기사로 표시
        const thin = description.length < 60 || description.startsWith(title.slice(0, 40));
        const source = /^https?:\/\//.test(outlet) ? new URL(outlet).hostname.replace(/^www\./, "") : outlet || feed.source;
        all.push({ title, url, source, description: thin ? "" : description, thin, published });
      }
    } catch (e) {
      console.warn(`feed skipped: ${feed.source} (${e.message})`);
    }
  }
  const seen = new Set();
  return all.filter((c) => c.title && !seen.has(c.title) && seen.add(c.title)).sort((a, b) => b.published - a.published).slice(0, 16);
}

// ── LLM (실행기 안의 Ollama) ─────────────────────────────────────────
async function ask(system, user) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // stream : CPU에서는 답이 몇 분 걸리므로, 조각으로 받아 fetch의 응답 대기 제한(5분)에 걸리지 않게 한다
    body: JSON.stringify({ model: MODEL, stream: true, format: "json", options: { temperature: 0.3, num_ctx: 8192 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(25 * 60000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let content = "";
  for (const line of (await res.text()).split("\n")) if (line.trim()) content += JSON.parse(line).message?.content ?? "";
  return JSON.parse(content);
}

const STYLE = `You write a daily briefing for HR business partners at a luxury fashion retailer in South Korea (store managers and client advisors in boutiques, department stores, duty-free shops and outlets).
Style: short sentences, concrete numbers, no jargon, no filler. Lead with the single most useful fact.
Mark the most important phrases with **double asterisks** (1-3 short phrases per field, never a whole sentence). No other markdown.
Write every field in Korean ("ko") and English ("en"). Reply with one JSON object only.`;

const text = (v, max = 1200) => {
  if (typeof v !== "string" || !v.trim()) throw new Error("missing text field in LLM output");
  return v.trim().slice(0, max);
};

// 근거가 제목뿐인 기사는 한 문장만 남긴다 (모델이 내용을 지어내지 못하게)
const firstSentence = (t) => t.match(/^.*?[.!?](?=\*{0,2}(\s|$))\*{0,2}/)?.[0] ?? t;

async function news(list) {
  if (DRY) return { ko: list.slice(0, 2).map((c) => ({ title: c.title, summary: c.description || c.title, takeaway: "", source: c.source, url: c.url })), en: [] };
  const out = await ask(
    STYLE,
    `Candidate articles (index, source, title, feed description):
${list.map((c, i) => `${i}. [${c.source}] ${c.title} :: ${c.description || "(no description)"}`).join("\n")}

Pick the 3 most useful for the reader (HR in luxury fashion / retail / frontline work first; skip finance, politics and anything unrelated to people management).
Base each summary ONLY on the title and description above. Do not add facts that are not there; if it says "(no description)", the summary is ONE sentence that only restates the title. Summaries are your own words, not copied sentences.
"takeaway" = one sentence on what an HR partner should check or do in their stores.
JSON shape: {"items":[{"index":0,"ko":{"summary":"","takeaway":""},"en":{"summary":"","takeaway":""}}]}`,
  );
  const picked = (out.items ?? []).filter((it) => Number.isInteger(it.index) && list[it.index]).slice(0, 3);
  if (picked.length === 0) throw new Error("LLM picked no valid news items");
  // 제목·출처·링크는 LLM 출력이 아니라 피드 원본에서 가져온다
  const side = (lang) => picked.map((it) => ({ title: list[it.index].title, summary: list[it.index].thin ? firstSentence(text(it[lang]?.summary)) : text(it[lang]?.summary), takeaway: text(it[lang]?.takeaway, 400), source: list[it.index].source, url: list[it.index].url }));
  return { ko: side("ko"), en: side("en") };
}

async function analysis(topic) {
  const fixed = { source: topic.source, url: topic.url };
  if (DRY) return { ko: { title: topic.title_ko, theory: topic.gist, methodology: "-", trend: "-", practice: "-", ...fixed }, en: null };
  const out = await ask(
    STYLE,
    `Explain this HR concept for the reader. Stay within what is well established about it; do not invent statistics or study results.
Concept: ${topic.title_en}
Source: ${topic.source}
Gist: ${topic.gist}

Fields (2-3 sentences each): "theory" (the core idea), "methodology" (how it is studied or measured), "trend" (where practice or research has gone since), "practice" (what to check at store level; never propose scoring or ranking individual employees).
JSON shape: {"ko":{"theory":"","methodology":"","trend":"","practice":""},"en":{"theory":"","methodology":"","trend":"","practice":""}}`,
  );
  const side = (lang, title) => ({ title, theory: text(out[lang]?.theory), methodology: text(out[lang]?.methodology), trend: text(out[lang]?.trend), practice: text(out[lang]?.practice), ...fixed });
  return { ko: side("ko", topic.title_ko), en: side("en", topic.title_en) };
}

// ── 조립 ────────────────────────────────────────────────────
const list = await candidates();
console.log(`${date}: ${list.length} candidate articles`);
if (list.length < 3) throw new Error("not enough news candidates — feeds may be down");

const topics = json("topics.json");
const laws = json("laws.json");
const topic = topics[dayNumber % topics.length];
const law = laws[dayNumber % laws.length];
const [n, a] = [await news(list), await analysis(topic)];

const briefing = {
  date,
  generated: { model: DRY ? "dry-run" : `${MODEL} (GitHub Actions)`, at: new Date().toISOString() },
  ko: { news: n.ko, analysis: a.ko, law: { statute: law.statute, article: law.article, ...law.ko, url: law.url } },
  en: { news: n.en, analysis: a.en, law: { statute: `${law.statute} (${law.statute_en})`, article: `${law.article.split(" ")[0]} (${law.article_en})`, ...law.en, url: law.url } },
};

if (DRY) {
  console.log(JSON.stringify(briefing.ko, null, 1).slice(0, 1500));
} else {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${date}.json`), JSON.stringify(briefing, null, 1) + "\n");
  let index = [];
  try { index = json("briefings/index.json"); } catch { /* 첫 실행 */ }
  writeFileSync(join(OUT, "index.json"), JSON.stringify([...new Set([...index, date])].sort(), null, 1) + "\n");
  console.log(`wrote briefings/${date}.json (${n.ko.length} news, analysis: ${topic.title_en}, law: ${law.article})`);
}
