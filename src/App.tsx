import Fuse, { type FuseResult, type IFuseOptions } from "fuse.js";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  FileSearch,
  Gauge,
  Github,
  Info,
  Layers3,
  Loader2,
  Menu,
  MessageSquareText,
  Search,
  Send,
  Sparkles,
  X,
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
  findAllMatches: true,
  includeMatches: true,
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.62,
  minMatchCharLength: 1,
  keys: [
    { name: "question", weight: 0.5 },
    { name: "answer", weight: 0.28 },
    { name: "paragraphs.text", weight: 0.22 },
    { name: "section", weight: 0.12 },
    { name: "tags", weight: 0.12 },
    { name: "metadataText", weight: 0.1 },
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

function searchFaqs(query: string, scopedFuse: Fuse<FaqItem>, globalFuse: Fuse<FaqItem>) {
  const scopedResults = scopedFuse.search(query);
  const globalResults = globalFuse.search(query);

  if (shouldUseScopedResults(scopedResults, globalResults)) {
    return scopedResults.slice(0, 7);
  }

  if (globalResults.length > 0) {
    return globalResults.slice(0, 7);
  }

  return tokenFallbackSearch(query, globalFuse.getIndex().docs).slice(0, 7);
}

function shouldUseScopedResults(scopedResults: FaqResult[], globalResults: FaqResult[]) {
  if (scopedResults.length === 0) {
    return false;
  }

  if (globalResults.length === 0) {
    return true;
  }

  const scopedScore = scopedResults[0].score ?? 1;
  const globalScore = globalResults[0].score ?? 1;

  return scopedScore <= globalScore + 0.08;
}

function tokenFallbackSearch(query: string, items: readonly FaqItem[]) {
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) {
    return [];
  }

  return items
    .map((item, refIndex) => {
      const haystack = searchableText(item);
      const matchedTokens = queryTokens.filter((token) => haystack.includes(token));
      const questionHits = matchedTokens.filter((token) => item.question.toLowerCase().includes(token)).length;
      const score = 1 - Math.min(0.98, (matchedTokens.length + questionHits * 0.65) / (queryTokens.length + 1.25));

      return {
        item,
        refIndex,
        score,
        matchedTokens: matchedTokens.length,
      };
    })
    .filter((result) => result.matchedTokens > 0)
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }

      return b.matchedTokens - a.matchedTokens;
    })
    .map(({ item, refIndex, score }) => ({ item, refIndex, score }) as FaqResult);
}

function searchableText(item: FaqItem) {
  return [
    item.question,
    item.answer,
    item.section,
    item.tags.join(" "),
    item.metadataText,
    item.paragraphs.map((paragraph) => paragraph.text).join(" "),
  ]
    .join(" ")
    .toLowerCase();
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

function renderMessageContent(text: string, role: ChatMessage["role"]) {
  if (role !== "assistant") {
    return <p>{text}</p>;
  }

  const lines = text.split("\n");
  const sourceIndex = lines.findIndex((line) => line.trim().startsWith("출처:"));

  if (sourceIndex === -1) {
    return <p>{text}</p>;
  }

  const beforeSource = lines.slice(0, sourceIndex).join("\n").trimEnd();
  const sourceLine = lines[sourceIndex].replace(/^출처:\s*/, "").trim();
  const afterSource = lines.slice(sourceIndex + 1).join("\n").trim();

  return (
    <>
      {beforeSource && <div className="answer-content">{renderAnswerLines(beforeSource)}</div>}
      {sourceLine && (
        <aside className="message-source-note" aria-label="답변 출처">
          <span>출처</span>
          <strong>{sourceLine}</strong>
        </aside>
      )}
      {afterSource && renderRelatedLines(afterSource)}
    </>
  );
}

function renderAnswerLines(text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nodes = [];
  let index = 0;
  let paragraphCount = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^Q\d+\./.test(line)) {
      nodes.push(
        <h3 className="answer-title" key={`title-${index}`}>
          {line}
        </h3>,
      );
      index += 1;
      continue;
    }

    if (line === "핵심 답변") {
      nodes.push(
        <div className="answer-section-label" key={`label-${index}`}>
          핵심 답변
        </div>,
      );
      index += 1;
      continue;
    }

    if (isAnswerSubheading(line)) {
      nodes.push(
        <h4 className="answer-subheading" key={`subheading-${index}`}>
          {line}
        </h4>,
      );
      index += 1;
      continue;
    }

    if (isKeyValueLine(line)) {
      const [label, ...valueParts] = line.split(/[:：]/);
      nodes.push(
        <div className="answer-key-value" key={`kv-${index}`}>
          <span>{label.trim()}</span>
          <strong>{valueParts.join(":").trim()}</strong>
        </div>,
      );
      index += 1;
      continue;
    }

    if (isListCandidate(line)) {
      const items = [];
      let itemIndex = index;
      while (itemIndex < lines.length && isListCandidate(lines[itemIndex])) {
        items.push(lines[itemIndex]);
        itemIndex += 1;
      }

      nodes.push(
        <ul className="answer-list" key={`list-${index}`}>
          {items.map((item, listIndex) => (
            <li key={`${index}-${listIndex}-${item}`}>{item}</li>
          ))}
        </ul>,
      );
      index = itemIndex;
      continue;
    }

    paragraphCount += 1;
    nodes.push(
      <p className={paragraphCount === 1 ? "answer-lead" : undefined} key={`p-${index}`}>
        {line}
      </p>,
    );
    index += 1;
  }

  return nodes;
}

function renderRelatedLines(text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines[0]?.replace(/:$/, "");
  const items = lines.slice(1);

  return (
    <aside className="message-related" aria-label="관련 FAQ">
      {title && <span>{title}</span>}
      {items.length > 0 && (
        <ul>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{item}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function isAnswerSubheading(line: string) {
  return /^(인정 가능|제한·불인정|허용되는 행위|금지되는 행위|발표 필수 구성|다음 행위는 금지됩니다|정산 증빙|증빙자료)$/.test(
    line,
  );
}

function isKeyValueLine(line: string) {
  return /^[가-힣A-Za-z0-9 /·()]{2,18}[:：]\s*\S+/.test(line);
}

function isListCandidate(line: string) {
  if (isAnswerSubheading(line) || isKeyValueLine(line) || /^Q\d+\./.test(line) || line === "핵심 답변") {
    return false;
  }

  if (line.length > 72) {
    return false;
  }

  return !/(습니다|합니다|됩니다|입니다|됩니다|있습니다|없습니다|않습니다|어렵습니다|가능합니다|됩니다\.|다\.|요\.)$/.test(line);
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
      `"${query}"와 관련된 FAQ를 찾지 못했습니다.`,
      "",
      "핵심어를 한두 개로 줄이거나 다른 표현으로 다시 검색해 주세요.",
    ].join("\n");
  }

  const [primary, ...related] = results.slice(0, 4);
  const item = primary.item;
  const relatedText = related
    .map((result) => `Q${result.item.questionNumber}. ${result.item.question}`)
    .join("\n");

  return [
    `Q${item.questionNumber}. ${item.question}`,
    "",
    "핵심 답변",
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
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
  const globalFuse = useMemo(
    () => new Fuse(indexData?.faqs ?? [], fuseOptions),
    [indexData],
  );

  const liveResults = useMemo(() => {
    const liveQuery = query.trim() || submittedQuery.trim();
    if (!liveQuery) {
      return filteredFaqs.slice(0, 6).map((item) => ({ item, score: 0.4 }) as FaqResult);
    }

    return searchFaqs(liveQuery, fuse, globalFuse);
  }, [filteredFaqs, fuse, globalFuse, query, submittedQuery]);

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
    const results = searchFaqs(cleanQuery, fuse, globalFuse);

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
    <main className={`app-shell ${isSidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <aside
        className={`sidebar ${isSidebarOpen ? "open" : "collapsed"}`}
        aria-label="인덱스 메타데이터와 섹션 필터"
      >
        <div className="brand-block">
          <div className="brand-mark">
            <Bot size={22} />
          </div>
          <div>
            <h1>AI 해커톤 FAQ 챗봇</h1>
            <p>Fuse.js 정적 검색</p>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => setIsSidebarOpen((current) => !current)}
            aria-expanded={isSidebarOpen}
            aria-label={isSidebarOpen ? "사이드바 접기" : "사이드바 열기"}
          >
            {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <div className="sidebar-content">
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
              <span>문서 수정</span>
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
        </div>
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

        <section className={`event-guide ${isGuideOpen ? "open" : ""}`} aria-labelledby="event-guide-title">
          <div className="event-guide-head">
            <div className="event-guide-title">
              <Info size={17} />
              <div>
                <h3 id="event-guide-title">대회 취지와 주제 안내</h3>
                <p>
                  당일 공개되는 시제에 따라 AI와 개발 도구로 실제 작동하는 대국민 서비스를 만드는 해커톤입니다.
                </p>
              </div>
            </div>
            <button
              className="event-guide-toggle"
              type="button"
              onClick={() => setIsGuideOpen((current) => !current)}
              aria-expanded={isGuideOpen}
            >
              {isGuideOpen ? "접기" : "전문 보기"}
            </button>
          </div>

          {isGuideOpen ? (
            <div className="event-guide-body">
              <p>
                2026년 AI챔피언 해커톤은 사전에 완성한 결과물을 제출하는 공모전이 아니라, 대회 당일 공개되는
                시제에 따라 제한된 시간 안에 문제를 정의하고, AI와 개발 도구를 활용하여 실제 작동하는 대국민
                서비스를 제작하는 해커톤입니다.
              </p>
              <p>이번 대회의 큰 분야는 <strong>복지혜택</strong>과 <strong>생활안전</strong>입니다.</p>
              <p>
                복지혜택 분야는 국민이 자신에게 필요한 지원, 제도, 서비스, 신청 절차 등을 더 쉽게 찾고 이해할 수
                있도록 돕는 서비스를 대상으로 합니다.
              </p>
              <p>
                생활안전 분야는 국민이 일상 속 위험, 재난, 사고, 취약지역, 안전시설, 대응 방법 등을 더 쉽게
                확인하고 행동할 수 있도록 돕는 서비스를 대상으로 합니다.
              </p>
              <p>
                다만 세부 시제와 구체적인 해결 과제는 대회 당일 현장에서 공개됩니다. 따라서 참가자는 복지혜택과
                생활안전 분야에 대한 기본적인 이해, 공개데이터 탐색, API 사용법, AI 도구 활용법, 배포 방식 등을
                사전에 익힐 수 있으나, 특정 세부주제를 가정하여 완성형 서비스나 작동 산출물을 미리 제작해 올
                필요는 없습니다.
              </p>
              <p>
                본 대회에서 중요한 것은 사전에 얼마나 많이 만들어 왔는지가 아니라, 당일 공개된 문제를 얼마나
                정확히 이해하고, AI와 도구를 활용하여 국민에게 실제로 쓸모 있는 결과물을 만들어내는가입니다.
              </p>
              <p>
                참가자는 사전 연습과 도구 숙련을 자유롭게 할 수 있습니다. 그러나 당일 공개될 시제에 맞춘 완성 코드,
                작동 가능한 서비스, 주제 맞춤형 프롬프트 체인, 자동화 워크플로우, 데이터 처리 로직 등을 미리 만들어
                와서 그대로 제출하는 행위는 허용되지 않습니다.
              </p>
              <p>
                <strong>정리하면, 사전 준비는 가능하되 사전 제작물 반입은 제한됩니다.</strong>
                <br />
                복지혜택과 생활안전이라는 큰 분야 안에서 준비하되, 세부 문제는 당일 공개되는 시제에 맞춰 현장에서
                새로 해결해 주시기 바랍니다.
              </p>
            </div>
          ) : (
            <div className="event-guide-summary" aria-label="안내 핵심 키워드">
              <span>복지혜택</span>
              <span>생활안전</span>
              <span>사전 준비 가능</span>
              <span>사전 제작물 반입 제한</span>
            </div>
          )}
        </section>

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
                {renderMessageContent(message.text, message.role)}
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
