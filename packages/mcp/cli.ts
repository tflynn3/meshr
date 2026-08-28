#!/usr/bin/env node
import { main } from "../../connector/cli.ts";

await main(process.argv.slice(2));
