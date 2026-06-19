import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputPath = path.join(rootDir, "public", "data", "faq-index.json");

const TAG_RULES = [
  ["AI 도구", /AI|LLM|ChatGPT|Gemini|Claude|Copilot|Cursor|Codex|생성형|코딩 에이전트/i],
  ["지원금", /지원금|정산|결제|영수증|구독|크레딧|비용|30만/i],
  ["계정", /계정|로그인|개인 계정|신규 생성|초기화/i],
  ["개발 환경", /노트북|PC|Windows|설치|환경|장비|모니터|키보드|마우스/i],
  ["데이터", /데이터|공공데이터|개인정보|민감정보|API|Key|Token|비공개/i],
  ["산출물", /산출물|서비스|URL|배포|시연|앱|확장프로그램|로컬/i],
  ["심사", /발표|심사|Q&A|시연|심사위원|본선|결선/i],
  ["규정", /금지|부정행위|제3자|외부인|출처|오픈소스|도용/i],
  ["운영", /점심|도시락|참석|운영|사무국|현장/i],
];

const QUESTION_RE = /^Q(\d+)\.\s*(.+)$/i;
const SECTION_RE = /^(\d+)\.\s+(.+)$/;
const PLAN_RE = /^([AB]안)\s*[—-]\s*(.+)$/;

function normalizeText(value) {
  return value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function getAttr(node, name) {
  return node?.getAttribute?.(name) ?? "";
}

function collectParagraphText(node) {
  const parts = [];

  function walk(current) {
    for (let i = 0; i < current.childNodes.length; i += 1) {
      const child = current.childNodes.item(i);
      if (child.nodeType !== 1) {
        continue;
      }

      if (child.nodeName === "w:t") {
        parts.push(child.textContent ?? "");
        continue;
      }

      if (child.nodeName === "w:tab") {
        parts.push(" ");
        continue;
      }

      if (child.nodeName === "w:br") {
        parts.push(" ");
        continue;
      }

      walk(child);
    }
  }

  walk(node);
  return normalizeText(parts.join(""));
}

function paragraphStyle(node) {
  const styles = node.getElementsByTagName("w:pStyle");
  if (!styles.length) {
    return "";
  }

  return getAttr(styles.item(0), "w:val");
}

function classifyParagraph(text) {
  if (QUESTION_RE.test(text)) {
    return "question";
  }

  if (SECTION_RE.test(text) || PLAN_RE.test(text) || text.startsWith("■")) {
    return "heading";
  }

  if (/^[•✅❌→]/.test(text) || /^[가-힣A-Za-z ]+:/.test(text)) {
    return "list";
  }

  return "body";
}

function tagsFor(text, section) {
  const source = `${section} ${text}`;
  return TAG_RULES.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
}

function compactAnswer(paragraphs) {
  return paragraphs.map((paragraph) => paragraph.text).join("\n");
}

async function findDocx() {
  if (process.env.FAQ_DOCX) {
    return path.resolve(rootDir, process.env.FAQ_DOCX);
  }

  const files = await readdir(rootDir);
  const docxFiles = files.filter((file) => file.toLowerCase().endsWith(".docx"));
  if (docxFiles.length === 0) {
    throw new Error("프로젝트 루트에서 DOCX 파일을 찾지 못했습니다.");
  }

  return path.join(rootDir, docxFiles[0]);
}

async function extractParagraphs(docxPath) {
  const buffer = await readFile(docxPath);
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file("word/document.xml");

  if (!documentFile) {
    throw new Error("DOCX 내부에서 word/document.xml을 찾지 못했습니다.");
  }

  const xml = await documentFile.async("text");
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = Array.from(dom.getElementsByTagName("w:p"));
  let currentPlan = "A안";
  let currentSection = "문서 안내";

  return nodes
    .map((node, index) => {
      const text = collectParagraphText(node);
      if (!text) {
        return null;
      }

      const planMatch = text.match(PLAN_RE);
      if (planMatch) {
        currentPlan = planMatch[1];
      }

      const sectionMatch = text.match(SECTION_RE);
      if (sectionMatch && !QUESTION_RE.test(text)) {
        currentSection = text;
      }

      const role = classifyParagraph(text);
      const tags = tagsFor(text, currentSection);

      return {
        id: `p${String(index + 1).padStart(3, "0")}`,
        order: index + 1,
        text,
        role,
        style: paragraphStyle(node),
        plan: currentPlan,
        section: currentSection,
        tags,
      };
    })
    .filter(Boolean);
}

function buildFaqs(paragraphs) {
  const faqs = [];
  let current = null;

  for (const paragraph of paragraphs) {
    const question = paragraph.text.match(QUESTION_RE);

    if (question) {
      if (current) {
        current.answer = compactAnswer(current.paragraphs);
        current.paragraphEnd = current.paragraphs.at(-1)?.id ?? current.questionParagraphId;
        current.tags = Array.from(new Set([...current.tags, ...tagsFor(current.answer, current.section)]));
        faqs.push(current);
      }

      current = {
        id: `q${String(question[1]).padStart(2, "0")}`,
        questionNumber: Number(question[1]),
        question: question[2].trim(),
        answer: "",
        section: paragraph.section,
        plan: paragraph.plan,
        questionParagraphId: paragraph.id,
        paragraphStart: paragraph.id,
        paragraphEnd: paragraph.id,
        paragraphs: [],
        tags: Array.from(new Set([...paragraph.tags, ...tagsFor(question[2], paragraph.section)])),
        metadataText: `${paragraph.plan} ${paragraph.section} Q${question[1]}`,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (paragraph.role === "heading") {
      continue;
    }

    current.paragraphs.push({
      id: paragraph.id,
      order: paragraph.order,
      text: paragraph.text,
      role: paragraph.role,
      tags: paragraph.tags,
    });
  }

  if (current) {
    current.answer = compactAnswer(current.paragraphs);
    current.paragraphEnd = current.paragraphs.at(-1)?.id ?? current.questionParagraphId;
    current.tags = Array.from(new Set([...current.tags, ...tagsFor(current.answer, current.section)]));
    faqs.push(current);
  }

  return faqs;
}

function buildSections(faqs) {
  const map = new Map();
  for (const faq of faqs) {
    if (!map.has(faq.section)) {
      map.set(faq.section, {
        name: faq.section,
        count: 0,
        questionNumbers: [],
      });
    }

    const section = map.get(faq.section);
    section.count += 1;
    section.questionNumbers.push(faq.questionNumber);
  }

  return Array.from(map.values());
}

async function main() {
  const docxPath = await findDocx();
  const docxStat = await stat(docxPath);
  const paragraphs = await extractParagraphs(docxPath);
  const faqs = buildFaqs(paragraphs);

  if (faqs.length === 0) {
    throw new Error("Q숫자. 형식의 FAQ를 찾지 못했습니다.");
  }

  const payload = {
    metadata: {
      title: "2026 AI챔피언 해커톤 FAQ",
      sourceFile: path.basename(docxPath),
      generatedAt: docxStat.mtime.toISOString(),
      indexMode: "static-docx-to-json",
      searchEngine: "Fuse.js",
      faqCount: faqs.length,
      paragraphCount: paragraphs.length,
      fields: [
        "question",
        "answer",
        "paragraphs.text",
        "section",
        "plan",
        "tags",
        "metadataText",
      ],
    },
    sections: buildSections(faqs),
    faqs,
    passages: paragraphs,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`FAQ index written: ${path.relative(rootDir, outputPath)}`);
  console.log(`FAQs: ${faqs.length}, paragraphs: ${paragraphs.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
