export const pathKey = (path: string) =>
  path.replaceAll("\\", "/").toLowerCase();

export function glob(pattern: string) {
  const source = pathKey(pattern).replace(
    /[.+?$^{}()|[\]\\]|\*\*\/|\*\*|\*/g,
    (word) =>
      word === "**/"
        ? "(?:.*/)?"
        : word === "**"
          ? ".*"
          : word === "*"
            ? "[^/]*"
            : "\\" + word,
  );
  const re = new RegExp("^" + source + "$");
  return (path: string) => re.test(pathKey(path));
}

export const defaultProtected = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "tests/**",
  "test/**",
  "**/test_*.py",
  "**/*_test.go",
  "**/vitest.config.*",
  "**/jest.config.*",
  "**/playwright.config.*",
  "**/pytest.ini",
  "**/conftest.py",
];
