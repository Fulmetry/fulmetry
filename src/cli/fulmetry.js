#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { main } from "./bin.ts";

process.exitCode = await main();
