export interface DocumentAnalysisResult {
  summary: string;
  keyPoints: string[];
  extraction: Record<string, any>;
}

export interface CreateDocumentRequest {
  filename: string;
  filePath: string;
  size: number;
  userId: string;
}
