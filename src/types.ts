export type Passage = {
  id: string;
  order: number;
  text: string;
  role: "question" | "heading" | "list" | "body";
  style?: string;
  plan?: string;
  section?: string;
  tags?: string[];
};

export type FaqParagraph = {
  id: string;
  order: number;
  text: string;
  role: Passage["role"];
  tags: string[];
};

export type FaqItem = {
  id: string;
  questionNumber: number;
  question: string;
  answer: string;
  section: string;
  plan: string;
  questionParagraphId: string;
  paragraphStart: string;
  paragraphEnd: string;
  paragraphs: FaqParagraph[];
  tags: string[];
  metadataText: string;
};

export type SectionSummary = {
  name: string;
  count: number;
  questionNumbers: number[];
};

export type FaqIndex = {
  metadata: {
    title: string;
    sourceFile: string;
    generatedAt: string;
    indexMode: string;
    searchEngine: string;
    faqCount: number;
    paragraphCount: number;
    fields: string[];
  };
  sections: SectionSummary[];
  faqs: FaqItem[];
  passages: Passage[];
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  isStreaming?: boolean;
};
