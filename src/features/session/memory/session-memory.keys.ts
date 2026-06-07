export function sessionStateV3Key(sessionId: string): string {
  return `session:${sessionId}:state:v3`;
}

export function sessionMemoryV3Key(sessionId: string): string {
  return `session:${sessionId}:memory:v3`;
}
