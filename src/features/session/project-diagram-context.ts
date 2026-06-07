export function isProjectExplainQuestion(question: string): boolean {
  const q = (question || "").toLowerCase().trim();
  if (!q) return false;
  const asksForCandidateProject =
    /\b(?:my|your|our|that|this|the|selected)\s+project\b/.test(q) ||
    /\bproject\s+(?:architecture|system|design|data flow|implementation flow|flow|diagram|technical flow)\b/.test(q) ||
    /\b(?:architecture|system|design|data flow|implementation flow|flow|diagram|technical flow)\s+(?:of|for|in|from)\s+(?:my|your|our|that|this|the|selected)\s+project\b/.test(q) ||
    /\bhow\s+(?:it|the project)\s+works\b/.test(q) ||
    /\bwalk me through (?:the )?(?:architecture|flow|design)\s+(?:of|for|in|from)\s+(?:my|your|our|that|this|the|selected)\s+project\b/.test(q);
  if (!asksForCandidateProject) {
    return false;
  }
  return (
    /\b(project|architecture|system|design|data flow|implementation flow|flow|diagram)\b/.test(q) &&
    /\b(architecture|system design|project flow|project diagram|data flow|implementation flow|technical flow|design choices?|how (?:it|the system|the project) works|walk me through (?:the )?(?:architecture|flow|design))\b/.test(q)
  );
}
