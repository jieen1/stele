#!/usr/bin/env node
import { SteleMcpServer from "../server.js";

const server = new SteleMcpServer();

await server.start();
