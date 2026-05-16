export interface TranscriptChunkMetadata {
  questionId?: string;
  question?: string;
  aiAnswer?: string;
  technologies: string[];
  difficulty?: string;
  startTime?: number;
  endTime?: number;
  speakerType?: string;
}

export interface AskAiQueryRequest {
  query: string;
}

export interface AskAiMessageResponse {
  role: "user" | "assistant";
  content: string;
  citations?: TranscriptChunkMetadata[];
}

export interface AskAiHistoryResponse {
  messages: AskAiMessageResponse[];
}
