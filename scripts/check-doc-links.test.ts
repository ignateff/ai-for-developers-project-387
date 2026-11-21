import { expect, it } from "vitest";
import { findMissingLinks } from "./check-doc-links.mjs";

it("checks local links while ignoring URLs, fragments and code examples", () => {
  const source = `
[existing](../README.md#section)
[missing](../missing.md)
[reference]: <../missing%20file.md> "title"
[external](https://example.com/a)
[fragment](#heading)
\`[example](../not-a-file.md)\`
\`\`\`md
[example](../also-not-a-file.md)
\`\`\`
`;
  expect(findMissingLinks("docs/example.md", source)).toEqual([
    "../missing.md",
    "../missing%20file.md",
  ]);
});
