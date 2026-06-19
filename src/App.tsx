import Fuse, { type FuseResult, type IFuseOptions } from "fuse.js";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  FileSearch,
  Gauge,
  Github,
  Layers3,
  Loader2,
  MessageSquareText,
  Search,
  Send,
  Sparkles,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, FaqIndex, FaqItem } from "./types";

type FaqResult = FuseResult<FaqItem>;

const starterQuestions = [
  "AI 도구는 무엇을 써도 되나요?",
  "지원금 정산은 언제부터 인정되나요?",
  "API 키를 하드코딩해도 되나요?",
  "개인 노트북을 사용할 수 있나요?",
];

const introMessage =
  "문서에서 추출한 FAQ 인덱스를 Fuse.js로 검색합니다. 질문을 입력하면 가장 가까운 FAQ와 출처 단락을 근거로 답변을 흘려보내듯 표시합니다.";

const fuseOptions: IFuseOptions<FaqItem> = {
  includeMatches: true,
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.38,
  minMatchCharLength: 2,
  keys: [
    { name: "question", weight: 0.42 },
    { name: "answer", weight: 0.34 },
    { name: "paragraphs.text", weight: 0.24 },
    { name: "section", weight: 0.12 },
    { name: "tags", weight: 0.1 },
    { name: "metadataText", weight: 0.08 },
  ],
};

function compactDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function tokenize(query: string) {
  return query
    .toLowerCase()
    .split(/[\s,./?!"'()·]+/)
    .map((token) =>
      token
        .trim()
        .replace(/(인가요|인가|나요|습니까|까요|세요|입니다|입니다요|어요|아요|요)$/u, "")
        .replace(/(으로|에서|에게|부터|까지|처럼|보다|만큼|이나|나|은|는|이|가|을|를|의|와|과|도|만|로)$/u, "")
        .replace(/(되는|된다|된)$/u, ""),
    )
    .filter((token) => token.length > 1);
}

function confidence(result: Pick<FaqResult, "item" | "score">, query: string) {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return 60;
  }

  const text = [
    result.item.question,
    result.item.answer,
    result.item.section,
    result.item.tags.join(" "),
    result.item.metadataText,
  ]
    .join(" ")
    .toLowerCase();
  const overlap = tokens.filter((token) => text.includes(token)).length / tokens.length;
  const scoreComponent = result.score === undefined ? 30 : (1 - Math.min(result.score, 1)) * 30;

  return Math.min(99, Math.max(35, Math.round(55 + overlap * 35 + scoreComponent)));
}

function highlighted(text: string, query: string) {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => {
    const isHit = tokens.includes(part.toLowerCase());
    return isHit ? <mark key={`${part}-${index}`}>{part}</mark> : part;
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bestSnippet(item: FaqItem, query: string) {
  const tokens = tokenize(query);
  const match =
    item.paragraphs.find((paragraph) =>
      tokens.some((token) => paragraph.text.toLowerCase().includes(token)),
    ) ?? item.paragraphs[0];

  if (!match) {
    return item.answer.slice(0, 180);
  }

  return match.text.length > 190 ? `${match.text.slice(0, 190)}...` : match.text;
}

function buildAnswer(query: string, results: FaqResult[]) {
  if (!results.length) {
    return [
      `"${query}"에 대한 직접 일치 FAQ를 찾지 못했습니다.`,
      "",
      "표현을 조금 바꿔 다시 검색하거나, 왼쪽의 섹션 필터를 전체로 돌려 확인해 주세요.",
    ].join("\n");
  }

  const [primary, ...related] = results.slice(0, 4);
  const item = primary.item;
  const relatedText = related
    .map((result) => `Q${result.item.questionNumber}. ${result.item.question}`)
    .join("\n");

  return [
    `문서 기준으로 가장 가까운 FAQ는 Q${item.questionNumber}입니다.`,
    "",
    `질문: ${item.question}`,
    "",
    item.answer,
    "",
    `출처: ${item.section} · ${item.paragraphStart}~${item.paragraphEnd} · 일치도 ${confidence(primary, query)}%`,
    relatedText ? `\n함께 볼 만한 항목:\n${relatedText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function App() {
  const [indexData, setIndexData] = useState<FaqIndex | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [activeSection, setActiveSection] = useState("전체");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      text: introMessage,
    },
  ]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${import.meta.env.BASE_URL}data/faq-index.json`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`FAQ 인덱스를 불러오지 못했습니다. (${response.status})`);
        }

        return response.json();
      })
      .then((data: FaqIndex) => setIndexData(data))
      .catch((error: Error) => {
        if (error.name !== "AbortError") {
          setLoadError(error.message);
        }
      });

    return () => controller.abort();
  }, []);

  const filteredFaqs = useMemo(() => {
    if (!indexData) {
      return [];
    }

    if (activeSection === "전체") {
      return indexData.faqs;
    }

    return indexData.faqs.filter((item) => item.section === activeSection);
  }, [activeSection, indexData]);

  const fuse = useMemo(() => new Fuse(filteredFaqs, fuseOptions), [filteredFaqs]);

  const liveResults = useMemo(() => {
    const liveQuery = query.trim() || submittedQuery.trim();
    if (!liveQuery) {
      return filteredFaqs.slice(0, 6).map((item) => ({ item, score: 0.4 }) as FaqResult);
    }

    return fuse.search(liveQuery).slice(0, 7);
  }, [filteredFaqs, fuse, query, submittedQuery]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function streamAssistantText(fullText: string) {
    const id = `assistant-${Date.now()}`;
    setStreamingId(id);
    setMessages((current) => [
      ...current,
      {
        id,
        role: "assistant",
        text: "",
        isStreaming: true,
      },
    ]);

    let cursor = 0;
    const tick = window.setInterval(() => {
      cursor += fullText.charCodeAt(cursor) > 127 ? 2 : 4;
      const nextText = fullText.slice(0, cursor);

      setMessages((current) =>
        current.map((message) =>
          message.id === id
            ? {
                ...message,
                text: nextText,
                isStreaming: nextText.length < fullText.length,
              }
            : message,
        ),
      );

      if (cursor >= fullText.length) {
        window.clearInterval(tick);
        setStreamingId(null);
      }
    }, 18);
  }

  function runQuestion(nextQuery: string) {
    if (!nextQuery.trim() || !indexData || streamingId) {
      return;
    }

    const cleanQuery = nextQuery.trim();
    const results = fuse.search(cleanQuery).slice(0, 7);

    setSubmittedQuery(cleanQuery);
    setQuery("");
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        text: cleanQuery,
      },
    ]);
    streamAssistantText(buildAnswer(cleanQuery, results));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runQuestion(query);
  }

  if (loadError) {
    return (
      <main className="load-state">
        <FileSearch size={36} />
        <h1>FAQ 인덱스를 열 수 없습니다</h1>
        <p>{loadError}</p>
      </main>
    );
  }

  if (!indexData) {
    return (
      <main className="load-state">
        <Loader2 className="spin" size={36} />
        <h1>FAQ 인덱스를 준비하는 중입니다</h1>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="인덱스 메타데이터와 섹션 필터">
        <div className="brand-block">
          <div className="brand-mark">
            <Bot size={22} />
          </div>
          <div>
            <h1>AI 해커톤 FAQ 챗봇</h1>
            <p>Fuse.js 정적 검색</p>
          </div>
        </div>

        <section className="status-panel">
          <div className="panel-title">
            <Database size={16} />
            인덱스 상태
          </div>
          <dl className="metric-grid">
            <div>
              <dt>FAQ</dt>
              <dd>{indexData.metadata.faqCount}</dd>
            </div>
            <div>
              <dt>단락</dt>
              <dd>{indexData.metadata.paragraphCount}</dd>
            </div>
          </dl>
          <div className="source-line">
            <span>원본</span>
            <strong>{indexData.metadata.sourceFile}</strong>
          </div>
          <div className="source-line">
            <span>생성</span>
            <strong>{compactDate(indexData.metadata.generatedAt)}</strong>
          </div>
        </section>

        <section className="filter-panel">
          <div className="panel-title">
            <Layers3 size={16} />
            섹션
          </div>
          <button
            className={activeSection === "전체" ? "section-button active" : "section-button"}
            onClick={() => setActiveSection("전체")}
          >
            <span>전체</span>
            <strong>{indexData.metadata.faqCount}</strong>
          </button>
          {indexData.sections.map((section) => (
            <button
              key={section.name}
              className={activeSection === section.name ? "section-button active" : "section-button"}
              onClick={() => setActiveSection(section.name)}
            >
              <span>{section.name.replace(/^\d+\.\s*/, "")}</span>
              <strong>{section.count}</strong>
            </button>
          ))}
        </section>

        <a className="repo-link" href="https://pages.github.com/" target="_blank" rel="noreferrer">
          <Github size={16} />
          GitHub Pages 배포형
        </a>
      </aside>

      <section className="chat-pane" aria-label="FAQ 챗봇">
        <header className="chat-header">
          <div>
            <h2>질문을 입력하세요</h2>
            <p>RAG/API 호출 없이 브라우저에서 문서 인덱스를 검색합니다.</p>
          </div>
          <div className="engine-badge">
            <Gauge size={16} />
            {indexData.metadata.searchEngine}
          </div>
        </header>

        <div className="starter-row" aria-label="예시 질문">
          {starterQuestions.map((item) => (
            <button key={item} onClick={() => runQuestion(item)} disabled={Boolean(streamingId)}>
              {item}
            </button>
          ))}
        </div>

        <div className="message-list">
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-avatar">
                {message.role === "assistant" ? <Bot size={17} /> : <MessageSquareText size={17} />}
              </div>
              <div className="message-bubble">
                <p>{message.text}</p>
                {message.isStreaming && (
                  <span className="stream-cursor" aria-label="답변 생성 중">
                    |
                  </span>
                )}
              </div>
            </article>
          ))}
          <div ref={chatEndRef} />
        </div>

        <form className="search-form" onSubmit={handleSubmit}>
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="예: 지원금으로 인정되는 항목은?"
            disabled={Boolean(streamingId)}
            aria-label="FAQ 검색어"
          />
          <button type="submit" disabled={!query.trim() || Boolean(streamingId)}>
            <Send size={17} />
            <span>전송</span>
          </button>
        </form>
      </section>

      <aside className="result-pane" aria-label="검색 결과와 출처 단락">
        <header className="result-header">
          <div>
            <h2>관련 FAQ</h2>
            <p>{(query || submittedQuery) ? `"${query || submittedQuery}"` : "상위 FAQ"}</p>
          </div>
          <Sparkles size={20} />
        </header>

        <div className="result-list">
          {liveResults.length === 0 ? (
            <div className="empty-results">
              <FileSearch size={22} />
              <strong>일치 결과가 없습니다</strong>
              <span>다른 섹션을 선택하거나 검색어를 조금 바꿔보세요.</span>
            </div>
          ) : liveResults.map((result) => (
            <article key={result.item.id} className="result-card">
              <div className="result-card-head">
                <span>Q{result.item.questionNumber}</span>
                <strong>{confidence(result, query || submittedQuery)}%</strong>
              </div>
              <h3>{highlighted(result.item.question, query || submittedQuery)}</h3>
              <p>{highlighted(bestSnippet(result.item, query || submittedQuery), query || submittedQuery)}</p>
              <div className="result-meta">
                <span>{result.item.section}</span>
                <span>{result.item.paragraphStart}~{result.item.paragraphEnd}</span>
              </div>
              <button onClick={() => runQuestion(result.item.question)} disabled={Boolean(streamingId)}>
                <CheckCircle2 size={15} />
                이 항목으로 답변
                <ChevronRight size={15} />
              </button>
            </article>
          ))}
        </div>
      </aside>
    </main>
  );
}

export default App;
