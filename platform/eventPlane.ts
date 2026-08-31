const service = process.argv[2];

switch (service) {
  case "bootstrap":
    await import("./bootstrap.ts");
    break;
  case "production-bootstrap":
    await (await import("./productionBootstrap.ts")).bootstrapProductionStores();
    break;
  case "seed-residents":
    await (await import("./residentSeeder.ts")).runResidentSeeder(process.argv.slice(3));
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
    throw new Error("usage: event-plane <bootstrap|production-bootstrap|seed-residents|ingest|materializer|live-gateway>");
}
