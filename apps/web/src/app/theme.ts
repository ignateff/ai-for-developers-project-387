import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Anchor the palette to the light and dark accents in the pen.dev design.
const brand: MantineColorsTuple = [
  "#e4f6f2",
  "#c8ebe5",
  "#a2dcd3",
  "#78cbbf",
  "#45afa2",
  "#299a90",
  "#087f7a",
  "#076d69",
  "#075b58",
  "#064a48",
];

export const theme = createTheme({
  primaryColor: "brand",
  autoContrast: true,
  primaryShade: { light: 6, dark: 4 },
  colors: { brand },
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  defaultRadius: "md",
  radius: { md: "8px", lg: "14px" },
});
