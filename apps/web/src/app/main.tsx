import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/cyrillic-400.css";
import "@fontsource/inter/cyrillic-500.css";
import "@fontsource/inter/cyrillic-600.css";
import "@fontsource/inter/cyrillic-700.css";
import "@mantine/core/styles.css";
import "./theme.css";
import "./log-version";
import { MantineProvider } from "@mantine/core";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { theme } from "./theme";
import { AppQueryProvider } from "./query-provider";
import { ThemePreview } from "./theme-preview";
import { Layout } from "../widgets/layout/layout";
import { MainPage } from "../pages/main/main";
import { BookPage } from "../pages/book/book";
import { AdminTypesPage } from "../pages/book/admin-types";
import { EventsPage } from "../pages/events/events";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppQueryProvider>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <BrowserRouter>
          <Routes>
            <Route path="/theme-preview" element={<ThemePreview />} />
            <Route element={<Layout />}>
              <Route index element={<MainPage />} />
              <Route path="/book" element={<BookPage />} />
              <Route path="/admin" element={<AdminTypesPage />} />
              <Route path="/admin/events" element={<EventsPage />} />
              <Route path="/events" element={<Navigate to="/admin/events" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </MantineProvider>
    </AppQueryProvider>
  </StrictMode>,
);
