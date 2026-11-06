import {
  createBudgetWorkflow,
  type Dependencies,
  type Options,
} from "./opencode-budget-workflow.ts";
import { createCommentBudgetLock } from "./opencode-budget-lock.ts";

/** The same workflow boundary is used by the CLI and by tests with API/runtime fixtures. */
export function createProductionWorkflow(deps: Pick<Dependencies, "fetch" | "prepare" | "model">) {
  return (options: Options) =>
    createBudgetWorkflow({
      ...deps,
      withLock: createCommentBudgetLock({
        fetch: deps.fetch,
        repository: options.repository,
        token: options.token,
        authorId: options.authorId,
      }),
    })(options);
}
