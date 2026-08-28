const service = process.argv[2];

switch (service) {
  case "bootstrap":
    await import("./bootstrap.ts");
    break;
  case "ingest":
    await import("./ingest.ts");
    break;
  case "materializer":
    await import("./materializer.ts");
    break;
  case "live-gateway":
    await import("./liveGateway.ts");
    break;
  default:
    throw new Error("usage: event-plane <bootstrap|ingest|materializer|live-gateway>");
}
