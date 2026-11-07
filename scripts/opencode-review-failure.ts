/** Only trusted runtime code may assert a confirmed failure reason. */
export class ReviewFailure extends Error {
  readonly reason: "timeout" | "agent_failed" | "cancelled";

  constructor(reason: "timeout" | "agent_failed" | "cancelled") {
    super(`OpenCode review: ${reason}; no review was produced`);
    this.reason = reason;
  }
}
