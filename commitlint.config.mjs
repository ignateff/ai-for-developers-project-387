export default {
  extends: ["@commitlint/config-conventional"],
  // Enforce the existing format, not additional line-length or casing standards.
  rules: {
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "header-max-length": [0],
    "subject-case": [0],
  },
};
