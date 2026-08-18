// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";

document.documentElement.classList.add("dark");
const root = document.getElementById("root");
if (!root) throw new Error("PCBoo application root is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
