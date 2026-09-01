import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_GCLOUD_JSON_BYTES = 16 * 1024 * 1024;
const MAX_GCLOUD_RECORDS = 10_000;

export interface FirestoreIndexField {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: "CONTAINS";
}

export interface ExpectedFirestoreIndex {
  resource: string;
  database: string;
  collectionGroup: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: FirestoreIndexField[];
}

export interface ExpectedFirestoreTtl {
  resource: string;
  database: string;
  collectionGroup: string;
  fieldPath: string;
}

export interface ExpectedFirestoreDatabase {
  resource: string;
  name: string;
  locationId: string;
  type: "FIRESTORE_NATIVE" | "DATASTORE_MODE";
  pointInTimeRecoveryEnablement:
    "POINT_IN_TIME_RECOVERY_ENABLED" | "POINT_IN_TIME_RECOVERY_DISABLED";
  deleteProtectionState:
    "DELETE_PROTECTION_ENABLED" | "DELETE_PROTECTION_DISABLED";
}

export interface ExpectedFirestoreBackupSchedule {
  resource: string;
  database: string;
  retention: string;
  recurrence: "DAILY";
}

export interface FirestoreReadinessManifest {
  databases: ExpectedFirestoreDatabase[];
  backupSchedules: ExpectedFirestoreBackupSchedule[];
  indexes: ExpectedFirestoreIndex[];
  ttls: ExpectedFirestoreTtl[];
}

export interface FirestoreDatabaseSnapshot {
  database: unknown;
  backupSchedules: unknown;
  indexes: unknown;
  ttls: unknown;
}

export interface FirestoreReadinessSnapshot {
  databases: Record<string, FirestoreDatabaseSnapshot>;
}

export interface FirestoreReadinessResult {
  databaseCount: number;
  protectedDatabaseCount: number;
  pitrEnabledDatabaseCount: number;
  readyBackupScheduleCount: number;
  readyIndexCount: number;
  activeTtlCount: number;
  issues: string[];
}

interface NamedBlock {
  name: string;
  body: string;
}

interface ActualFirestoreIndex {
  database: string;
  collectionGroup: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: FirestoreIndexField[];
  state: string;
}

interface ActualFirestoreTtl {
  database: string;
  collectionGroup: string;
  fieldPath: string;
  state: string;
}

interface ActualFirestoreDatabase {
  name: string;
  locationId: string;
  type: string;
  pointInTimeRecoveryEnablement: string;
  deleteProtectionState: string;
}

interface ActualFirestoreBackupSchedule {
  database: string;
  retention: string;
  recurrence: "DAILY";
}

const skipTrivia = (source: string, start: number): number => {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s|,/u.test(source[cursor]!)) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("#", cursor) || source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor);
      return newline === -1 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) throw new Error("unterminated block comment in OpenTofu");
      cursor = end + 2;
      continue;
    }
    break;
  }
  return cursor;
};

const balancedBody = (
  source: string,
  openIndex: number,
  openCharacter: "{" | "[",
): { body: string; end: number } => {
  const closeCharacter = openCharacter === "{" ? "}" : "]";
  if (source[openIndex] !== openCharacter) {
    throw new Error(`expected ${openCharacter} while parsing OpenTofu`);
  }
  let depth = 1;
  let cursor = openIndex + 1;
  let quote: '"' | "'" | null = null;
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (quote) {
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (source.startsWith("#", cursor) || source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) throw new Error("unterminated block comment in OpenTofu");
      cursor = end + 2;
      continue;
    }
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(openIndex + 1, cursor), end: cursor + 1 };
      }
    }
    cursor += 1;
  }
  throw new Error(`unterminated ${openCharacter} block in OpenTofu`);
};

const findNamedBlocks = (source: string, pattern: RegExp): NamedBlock[] => {
  const matches: NamedBlock[] = [];
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || !match[1]) continue;
    const openIndex = match.index + match[0].lastIndexOf("{");
    matches.push({
      name: match[1],
      body: balancedBody(source, openIndex, "{").body,
    });
  }
  return matches;
};

const findLocalObject = (source: string, name: string): string => {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*\\{`, "g");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]!.index === undefined) {
    throw new Error(`expected exactly one local.${name} object in OpenTofu`);
  }
  const match = matches[0]!;
  const openIndex = match.index! + match[0].lastIndexOf("{");
  return balancedBody(source, openIndex, "{").body;
};

const parseObjectEntries = (body: string): NamedBlock[] => {
  const entries: NamedBlock[] = [];
  let cursor = 0;
  while ((cursor = skipTrivia(body, cursor)) < body.length) {
    const key = body.slice(cursor).match(/^([A-Za-z_][A-Za-z0-9_-]*)/u)?.[1];
    if (!key) throw new Error("could not parse an OpenTofu object key");
    cursor += key.length;
    cursor = skipTrivia(body, cursor);
    if (body[cursor] !== "=") {
      throw new Error(`expected an object value for OpenTofu key ${key}`);
    }
    cursor = skipTrivia(body, cursor + 1);
    if (body[cursor] !== "{") {
      throw new Error(`expected an object value for OpenTofu key ${key}`);
    }
    const value = balancedBody(body, cursor, "{");
    entries.push({ name: key, body: value.body });
    cursor = value.end;
  }
  if (entries.length === 0)
    throw new Error("OpenTofu object unexpectedly had no entries");
  return entries;
};

const literal = (body: string, key: string): string => {
  const values = [
    ...body.matchAll(new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`, "g")),
  ].map((match) => match[1]!);
  if (values.length !== 1) {
    throw new Error(`expected one literal ${key} assignment in OpenTofu`);
  }
  return values[0]!;
};

const optionalLiteral = (body: string, key: string): string | undefined => {
  const assignments = [
    ...body.matchAll(new RegExp(`\\b${key}\\s*=\\s*([^\\n]+)`, "g")),
  ];
  if (assignments.length > 1) {
    throw new Error(`expected at most one ${key} assignment in OpenTofu`);
  }
  if (assignments.length === 0) return undefined;
  const value = assignments[0]![1]!
    .trim()
    .replace(/\s+#.*$/u, "")
    .trim();
  const match = value.match(/^"([^"]+)"$/u);
  if (!match) {
    throw new Error(`expected a literal ${key} assignment in OpenTofu`);
  }
  return match[1]!;
};

const expectedDatabaseLocation = (body: string, locationId: string): string => {
  const assignments = [...body.matchAll(/\blocation_id\s*=\s*([^\n]+)/g)];
  if (assignments.length !== 1) {
    throw new Error(
      "expected one location_id assignment in Firestore database",
    );
  }
  const value = assignments[0]![1]!
    .trim()
    .replace(/\s+#.*$/u, "")
    .trim();
  if (value === "var.region") return locationId;
  const literalValue = value.match(/^"([^"]+)"$/u)?.[1];
  if (!literalValue) {
    throw new Error(
      "Firestore database location_id must be var.region or a literal",
    );
  }
  return literalValue;
};

const databaseReference = (body: string): string => {
  const matches = [
    ...body.matchAll(
      /\bdatabase\s*=\s*google_firestore_database\.([A-Za-z0-9_]+)\.name/g,
    ),
  ];
  if (matches.length !== 1) {
    throw new Error("expected one Firestore database reference in OpenTofu");
  }
  return matches[0]![1]!;
};

const parseIndexField = (body: string): FirestoreIndexField => {
  const fieldPath = literal(body, "field_path");
  const order = body.match(/\border\s*=\s*"(ASCENDING|DESCENDING)"/)?.[1] as
    "ASCENDING" | "DESCENDING" | undefined;
  const arrayConfig = body.match(/\barray_config\s*=\s*"(CONTAINS)"/)?.[1] as
    "CONTAINS" | undefined;
  if ((order ? 1 : 0) + (arrayConfig ? 1 : 0) !== 1) {
    throw new Error(
      `Firestore index field ${fieldPath} needs exactly one mode`,
    );
  }
  return { fieldPath, ...(order ? { order } : { arrayConfig: arrayConfig! }) };
};

const parseObjectList = (body: string, assignment: string): string[] => {
  const match = body.match(new RegExp(`\\b${assignment}\\s*=\\s*\\[`));
  if (!match || match.index === undefined) {
    throw new Error(`missing ${assignment} list in OpenTofu`);
  }
  const openIndex = match.index + match[0].lastIndexOf("[");
  const list = balancedBody(body, openIndex, "[").body;
  const entries: string[] = [];
  let cursor = 0;
  while ((cursor = skipTrivia(list, cursor)) < list.length) {
    if (list[cursor] !== "{") {
      throw new Error(`expected an object in OpenTofu ${assignment}`);
    }
    const value = balancedBody(list, cursor, "{");
    entries.push(value.body);
    cursor = value.end;
  }
  if (entries.length < 2) {
    throw new Error(
      `Firestore composite index ${assignment} has fewer than two fields`,
    );
  }
  return entries;
};

const parseFixedIndexFields = (body: string): FirestoreIndexField[] => {
  const fields = findNamedBlocks(body, /\b(fields)\s*\{/g).map(
    ({ body: field }) => parseIndexField(field),
  );
  if (fields.length < 2) {
    throw new Error(
      "Firestore composite index has fewer than two literal fields",
    );
  }
  return fields;
};

const withImplicitNameField = (
  fields: FirestoreIndexField[],
): FirestoreIndexField[] => {
  if (fields.some((field) => field.fieldPath === "__name__")) return fields;
  const last = fields.at(-1)!;
  return [
    ...fields,
    {
      fieldPath: "__name__",
      order: last.order ?? "ASCENDING",
    },
  ];
};

export const extractFirestoreReadinessManifest = (
  source: string,
  locationId: string,
): FirestoreReadinessManifest => {
  const databaseBlocks = findNamedBlocks(
    source,
    /resource\s+"google_firestore_database"\s+"([^"]+)"\s*\{/g,
  );
  if (databaseBlocks.length === 0) {
    throw new Error("OpenTofu declares no Firestore databases");
  }
  const databases: ExpectedFirestoreDatabase[] = databaseBlocks.map(
    ({ name: resource, body }) => {
      const type = optionalLiteral(body, "type");
      if (type !== "FIRESTORE_NATIVE" && type !== "DATASTORE_MODE") {
        throw new Error(
          `Firestore database ${resource} has an unsupported type`,
        );
      }
      const pointInTimeRecoveryEnablement =
        optionalLiteral(body, "point_in_time_recovery_enablement") ??
        "POINT_IN_TIME_RECOVERY_DISABLED";
      if (
        pointInTimeRecoveryEnablement !== "POINT_IN_TIME_RECOVERY_ENABLED" &&
        pointInTimeRecoveryEnablement !== "POINT_IN_TIME_RECOVERY_DISABLED"
      ) {
        throw new Error(
          `Firestore database ${resource} has an unsupported PITR setting`,
        );
      }
      const deleteProtectionState =
        optionalLiteral(body, "delete_protection_state") ??
        "DELETE_PROTECTION_DISABLED";
      if (
        deleteProtectionState !== "DELETE_PROTECTION_ENABLED" &&
        deleteProtectionState !== "DELETE_PROTECTION_DISABLED"
      ) {
        throw new Error(
          `Firestore database ${resource} has an unsupported delete-protection setting`,
        );
      }
      return {
        resource,
        name: literal(body, "name"),
        locationId: expectedDatabaseLocation(body, locationId),
        type,
        pointInTimeRecoveryEnablement,
        deleteProtectionState,
      };
    },
  );
  const databaseNames = new Map(
    databases.map(({ resource, name }) => [resource, name]),
  );
  if (new Set(databaseNames.values()).size !== databaseNames.size) {
    throw new Error("OpenTofu declares duplicate Firestore database names");
  }

  const backupSchedules: ExpectedFirestoreBackupSchedule[] = [];
  for (const { name, body } of findNamedBlocks(
    source,
    /resource\s+"google_firestore_backup_schedule"\s+"([^"]+)"\s*\{/g,
  )) {
    const databaseLabel = databaseReference(body);
    const database = databaseNames.get(databaseLabel);
    if (!database) {
      throw new Error(`backup schedule ${name} references an unknown database`);
    }
    const dailyCount = findNamedBlocks(
      body,
      /\b(daily_recurrence)\s*\{/g,
    ).length;
    const weeklyCount = findNamedBlocks(
      body,
      /\b(weekly_recurrence)\s*\{/g,
    ).length;
    if (dailyCount !== 1 || weeklyCount !== 0) {
      throw new Error(
        `backup schedule ${name} must declare exactly one daily recurrence`,
      );
    }
    backupSchedules.push({
      resource: name,
      database,
      retention: literal(body, "retention"),
      recurrence: "DAILY",
    });
  }

  const indexes: ExpectedFirestoreIndex[] = [];
  for (const { name, body } of findNamedBlocks(
    source,
    /resource\s+"google_firestore_index"\s+"([^"]+)"\s*\{/g,
  )) {
    const databaseLabel = databaseReference(body);
    const database = databaseNames.get(databaseLabel);
    if (!database)
      throw new Error(`index ${name} references an unknown database`);
    const forEach = body.match(/\bfor_each\s*=\s*local\.([A-Za-z0-9_]+)/)?.[1];
    if (forEach) {
      for (const entry of parseObjectEntries(
        findLocalObject(source, forEach),
      )) {
        indexes.push({
          resource: `${name}[${entry.name}]`,
          database,
          collectionGroup: literal(entry.body, "collection"),
          queryScope: "COLLECTION",
          fields: withImplicitNameField(
            parseObjectList(entry.body, "fields").map(parseIndexField),
          ),
        });
      }
      continue;
    }
    indexes.push({
      resource: name,
      database,
      collectionGroup: literal(body, "collection"),
      queryScope:
        (body.match(
          /\bquery_scope\s*=\s*"(COLLECTION|COLLECTION_GROUP)"/,
        )?.[1] as "COLLECTION" | "COLLECTION_GROUP" | undefined) ??
        "COLLECTION",
      fields: withImplicitNameField(parseFixedIndexFields(body)),
    });
  }

  const ttls: ExpectedFirestoreTtl[] = [];
  for (const { name, body } of findNamedBlocks(
    source,
    /resource\s+"google_firestore_field"\s+"([^"]+)"\s*\{/g,
  )) {
    if (!/\bttl_config\s*\{/u.test(body)) continue;
    const databaseLabel = databaseReference(body);
    const database = databaseNames.get(databaseLabel);
    if (!database)
      throw new Error(`TTL ${name} references an unknown database`);
    const forEach = body.match(/\bfor_each\s*=\s*local\.([A-Za-z0-9_]+)/)?.[1];
    if (forEach) {
      for (const entry of parseObjectEntries(
        findLocalObject(source, forEach),
      )) {
        ttls.push({
          resource: `${name}[${entry.name}]`,
          database,
          collectionGroup: literal(entry.body, "collection"),
          fieldPath: literal(entry.body, "field"),
        });
      }
      continue;
    }
    ttls.push({
      resource: name,
      database,
      collectionGroup: literal(body, "collection"),
      fieldPath: literal(body, "field"),
    });
  }

  if (
    backupSchedules.length === 0 ||
    indexes.length === 0 ||
    ttls.length === 0
  ) {
    throw new Error(
      "OpenTofu Firestore readiness manifest is unexpectedly empty",
    );
  }
  const backupScheduleSignatures = backupSchedules.map(backupScheduleSignature);
  const indexSignatures = indexes.map(indexSignature);
  const ttlSignatures = ttls.map(ttlSignature);
  if (new Set(indexSignatures).size !== indexSignatures.length) {
    throw new Error("OpenTofu declares duplicate Firestore composite indexes");
  }
  if (new Set(ttlSignatures).size !== ttlSignatures.length) {
    throw new Error("OpenTofu declares duplicate Firestore TTL policies");
  }
  if (
    new Set(backupScheduleSignatures).size !== backupScheduleSignatures.length
  ) {
    throw new Error("OpenTofu declares duplicate Firestore backup schedules");
  }

  return {
    databases: databases.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    backupSchedules: backupSchedules.sort((left, right) =>
      backupScheduleSignature(left).localeCompare(
        backupScheduleSignature(right),
      ),
    ),
    indexes: indexes.sort((left, right) =>
      indexSignature(left).localeCompare(indexSignature(right)),
    ),
    ttls: ttls.sort((left, right) =>
      ttlSignature(left).localeCompare(ttlSignature(right)),
    ),
  };
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`gcloud returned an invalid ${label} record`);
  }
  return value as Record<string, unknown>;
};

const stringValue = (
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey,
): string | undefined => {
  const value = record[camelKey] ?? record[snakeKey];
  return typeof value === "string" ? value : undefined;
};

const strictStringValue = (
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey,
): string | undefined => {
  const camelValue = record[camelKey];
  const snakeValue = snakeKey === camelKey ? undefined : record[snakeKey];
  if (camelValue !== undefined && snakeValue !== undefined) {
    throw new Error(`gcloud returned ambiguous ${camelKey} values`);
  }
  const value = camelValue ?? snakeValue;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`gcloud returned a non-string ${camelKey} value`);
  }
  return value;
};

const resourceSegments = (
  name: string,
  project: string,
  database: string,
): { collectionGroup: string; remainder: string[] } => {
  const prefix = `projects/${project}/databases/${database}/collectionGroups/`;
  if (!name.startsWith(prefix)) {
    throw new Error(
      `gcloud returned a Firestore resource outside database ${database}`,
    );
  }
  const segments = name.slice(prefix.length).split("/").map(decodeURIComponent);
  if (!segments[0])
    throw new Error("gcloud returned an invalid Firestore resource name");
  return { collectionGroup: segments[0], remainder: segments.slice(1) };
};

const parseActualIndexes = (
  raw: unknown,
  project: string,
  database: string,
): ActualFirestoreIndex[] => {
  if (!Array.isArray(raw)) {
    throw new Error(`gcloud index JSON for ${database} was not an array`);
  }
  if (raw.length > MAX_GCLOUD_RECORDS) {
    throw new Error(
      `gcloud index JSON for ${database} exceeded the record limit`,
    );
  }
  return raw.map((value) => {
    const record = asRecord(value, "index");
    const name = stringValue(record, "name");
    const state = stringValue(record, "state");
    const queryScope =
      stringValue(record, "queryScope", "query_scope") ?? "COLLECTION";
    if (!name || !state || !Array.isArray(record.fields)) {
      throw new Error(
        `gcloud returned an incomplete index record for ${database}`,
      );
    }
    if (queryScope !== "COLLECTION" && queryScope !== "COLLECTION_GROUP") {
      throw new Error(
        `gcloud returned an unsupported index scope for ${database}`,
      );
    }
    const resource = resourceSegments(name, project, database);
    if (resource.remainder[0] !== "indexes" || !resource.remainder[1]) {
      throw new Error(`gcloud returned an invalid index name for ${database}`);
    }
    const fields = record.fields.map((fieldValue) => {
      const field = asRecord(fieldValue, "index field");
      const fieldPath = stringValue(field, "fieldPath", "field_path");
      const order = stringValue(field, "order");
      const arrayConfig = stringValue(field, "arrayConfig", "array_config");
      if (!fieldPath || (order ? 1 : 0) + (arrayConfig ? 1 : 0) !== 1) {
        throw new Error(
          `gcloud returned an invalid index field for ${database}`,
        );
      }
      if (order !== "ASCENDING" && order !== "DESCENDING") {
        if (arrayConfig !== "CONTAINS") {
          throw new Error(
            `gcloud returned an unsupported index mode for ${database}`,
          );
        }
        return { fieldPath, arrayConfig: "CONTAINS" as const };
      }
      return {
        fieldPath,
        order: order as "ASCENDING" | "DESCENDING",
      };
    });
    if (fields.length < 2) {
      throw new Error(
        `gcloud returned an incomplete composite index for ${database}`,
      );
    }
    return {
      database,
      collectionGroup: resource.collectionGroup,
      queryScope,
      fields,
      state,
    };
  });
};

const parseActualTtls = (
  raw: unknown,
  project: string,
  database: string,
): ActualFirestoreTtl[] => {
  if (!Array.isArray(raw)) {
    throw new Error(`gcloud TTL JSON for ${database} was not an array`);
  }
  if (raw.length > MAX_GCLOUD_RECORDS) {
    throw new Error(
      `gcloud TTL JSON for ${database} exceeded the record limit`,
    );
  }
  return raw.map((value) => {
    const record = asRecord(value, "TTL");
    const name = stringValue(record, "name");
    const ttlConfig = asRecord(
      record.ttlConfig ?? record.ttl_config,
      "TTL config",
    );
    const state = stringValue(ttlConfig, "state");
    if (!name || !state) {
      throw new Error(
        `gcloud returned an incomplete TTL record for ${database}`,
      );
    }
    const resource = resourceSegments(name, project, database);
    if (resource.remainder[0] !== "fields" || !resource.remainder[1]) {
      throw new Error(`gcloud returned an invalid TTL name for ${database}`);
    }
    return {
      database,
      collectionGroup: resource.collectionGroup,
      fieldPath: resource.remainder[1],
      state,
    };
  });
};

const parseActualDatabase = (
  raw: unknown,
  project: string,
  database: string,
): ActualFirestoreDatabase => {
  const record = asRecord(raw, "database");
  const name = strictStringValue(record, "name");
  const locationId = strictStringValue(record, "locationId", "location_id");
  const type = strictStringValue(record, "type");
  const pointInTimeRecoveryEnablement = strictStringValue(
    record,
    "pointInTimeRecoveryEnablement",
    "point_in_time_recovery_enablement",
  );
  const deleteProtectionState = strictStringValue(
    record,
    "deleteProtectionState",
    "delete_protection_state",
  );
  if (
    !name ||
    !locationId ||
    !type ||
    !pointInTimeRecoveryEnablement ||
    !deleteProtectionState
  ) {
    throw new Error(
      `gcloud returned incomplete database settings for ${database}`,
    );
  }
  if (name !== `projects/${project}/databases/${database}`) {
    throw new Error(
      `gcloud returned settings for the wrong database ${database}`,
    );
  }
  return {
    name: database,
    locationId,
    type,
    pointInTimeRecoveryEnablement,
    deleteProtectionState,
  };
};

const parseActualBackupSchedules = (
  raw: unknown,
  project: string,
  database: string,
): ActualFirestoreBackupSchedule[] => {
  if (!Array.isArray(raw)) {
    throw new Error(
      `gcloud backup-schedule JSON for ${database} was not an array`,
    );
  }
  if (raw.length > MAX_GCLOUD_RECORDS) {
    throw new Error(
      `gcloud backup-schedule JSON for ${database} exceeded the record limit`,
    );
  }
  return raw.map((value) => {
    const record = asRecord(value, "backup schedule");
    const name = strictStringValue(record, "name");
    const retention = strictStringValue(record, "retention");
    const dailyCamel = record.dailyRecurrence;
    const dailySnake = record.daily_recurrence;
    const weeklyCamel = record.weeklyRecurrence;
    const weeklySnake = record.weekly_recurrence;
    if (dailyCamel !== undefined && dailySnake !== undefined) {
      throw new Error(
        `gcloud returned ambiguous daily recurrence for ${database}`,
      );
    }
    if (weeklyCamel !== undefined && weeklySnake !== undefined) {
      throw new Error(
        `gcloud returned ambiguous weekly recurrence for ${database}`,
      );
    }
    const dailyRecurrence = dailyCamel ?? dailySnake;
    const weeklyRecurrence = weeklyCamel ?? weeklySnake;
    if (!name || !retention) {
      throw new Error(
        `gcloud returned an incomplete backup schedule for ${database}`,
      );
    }
    const prefix = `projects/${project}/databases/${database}/backupSchedules/`;
    if (
      !name.startsWith(prefix) ||
      !name.slice(prefix.length).match(/^[^/]+$/u)
    ) {
      throw new Error(
        `gcloud returned a backup schedule outside database ${database}`,
      );
    }
    if (
      !dailyRecurrence ||
      typeof dailyRecurrence !== "object" ||
      Array.isArray(dailyRecurrence) ||
      weeklyRecurrence !== undefined
    ) {
      throw new Error(
        `gcloud returned an unsupported backup recurrence for ${database}`,
      );
    }
    return { database, retention, recurrence: "DAILY" };
  });
};

const indexSignature = (index: {
  database: string;
  collectionGroup: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: FirestoreIndexField[];
}): string =>
  JSON.stringify([
    index.database,
    index.collectionGroup,
    index.queryScope,
    index.fields.map((field) => [
      field.fieldPath,
      field.order ?? null,
      field.arrayConfig ?? null,
    ]),
  ]);

const ttlSignature = (ttl: {
  database: string;
  collectionGroup: string;
  fieldPath: string;
}): string =>
  JSON.stringify([ttl.database, ttl.collectionGroup, ttl.fieldPath]);

const backupScheduleSignature = (schedule: {
  database: string;
  retention: string;
  recurrence: "DAILY";
}): string =>
  JSON.stringify([schedule.database, schedule.retention, schedule.recurrence]);

const describeIndex = (index: {
  database: string;
  collectionGroup: string;
  fields: FirestoreIndexField[];
}): string =>
  `${index.database}/${index.collectionGroup} (${index.fields
    .map((field) => `${field.fieldPath}:${field.order ?? field.arrayConfig}`)
    .join(",")})`;

const describeTtl = (ttl: {
  database: string;
  collectionGroup: string;
  fieldPath: string;
}): string => `${ttl.database}/${ttl.collectionGroup}.${ttl.fieldPath}`;

export const compareFirestoreReadiness = (
  manifest: FirestoreReadinessManifest,
  snapshot: FirestoreReadinessSnapshot,
  project: string,
): FirestoreReadinessResult => {
  if (
    manifest.databases.length === 0 ||
    manifest.backupSchedules.length === 0 ||
    manifest.indexes.length === 0 ||
    manifest.ttls.length === 0
  ) {
    throw new Error(
      "Firestore readiness manifest must contain databases, backup schedules, indexes, and TTLs",
    );
  }
  const issues: string[] = [];
  const actualDatabases: ActualFirestoreDatabase[] = [];
  const actualBackupSchedules: ActualFirestoreBackupSchedule[] = [];
  const actualIndexes: ActualFirestoreIndex[] = [];
  const actualTtls: ActualFirestoreTtl[] = [];
  for (const expectedDatabase of manifest.databases) {
    const database = expectedDatabase.name;
    const databaseSnapshot = snapshot.databases[database];
    if (!databaseSnapshot) {
      issues.push(`missing gcloud snapshot for database ${database}`);
      continue;
    }
    try {
      actualDatabases.push(
        parseActualDatabase(databaseSnapshot.database, project, database),
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : `invalid settings for ${database}`,
      );
    }
    try {
      actualBackupSchedules.push(
        ...parseActualBackupSchedules(
          databaseSnapshot.backupSchedules,
          project,
          database,
        ),
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : `invalid backup schedules for ${database}`,
      );
    }
    try {
      actualIndexes.push(
        ...parseActualIndexes(databaseSnapshot.indexes, project, database),
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : `invalid indexes for ${database}`,
      );
    }
    try {
      actualTtls.push(
        ...parseActualTtls(databaseSnapshot.ttls, project, database),
      );
    } catch (error) {
      issues.push(
        error instanceof Error ? error.message : `invalid TTLs for ${database}`,
      );
    }
  }

  const actualDatabaseByName = new Map(
    actualDatabases.map((database) => [database.name, database]),
  );
  for (const database of manifest.databases) {
    const actual = actualDatabaseByName.get(database.name);
    if (!actual) continue;
    if (actual.locationId !== database.locationId) {
      issues.push(
        `database ${database.name} is in ${actual.locationId}, not ${database.locationId}`,
      );
    }
    if (actual.type !== database.type) {
      issues.push(
        `database ${database.name} type is ${actual.type}, not ${database.type}`,
      );
    }
    if (
      actual.pointInTimeRecoveryEnablement !==
      database.pointInTimeRecoveryEnablement
    ) {
      issues.push(
        `database ${database.name} PITR is ${actual.pointInTimeRecoveryEnablement}, not ${database.pointInTimeRecoveryEnablement}`,
      );
    }
    if (actual.deleteProtectionState !== database.deleteProtectionState) {
      issues.push(
        `database ${database.name} delete protection is ${actual.deleteProtectionState}, not ${database.deleteProtectionState}`,
      );
    }
  }

  const expectedBackupScheduleBySignature = new Map(
    manifest.backupSchedules.map((schedule) => [
      backupScheduleSignature(schedule),
      schedule,
    ]),
  );
  const actualBackupScheduleBySignature = new Map<
    string,
    ActualFirestoreBackupSchedule[]
  >();
  for (const schedule of actualBackupSchedules) {
    const signature = backupScheduleSignature(schedule);
    actualBackupScheduleBySignature.set(signature, [
      ...(actualBackupScheduleBySignature.get(signature) ?? []),
      schedule,
    ]);
  }
  for (const schedule of manifest.backupSchedules) {
    const matches =
      actualBackupScheduleBySignature.get(backupScheduleSignature(schedule)) ??
      [];
    if (matches.length === 0) {
      issues.push(
        `missing ${schedule.recurrence.toLowerCase()} backup schedule for ${schedule.database} with retention ${schedule.retention}`,
      );
    } else if (matches.length > 1) {
      issues.push(
        `duplicate ${schedule.recurrence.toLowerCase()} backup schedule for ${schedule.database} with retention ${schedule.retention}`,
      );
    }
  }
  for (const schedule of actualBackupSchedules) {
    if (
      !expectedBackupScheduleBySignature.has(backupScheduleSignature(schedule))
    ) {
      issues.push(
        `unexpected ${schedule.recurrence.toLowerCase()} backup schedule for ${schedule.database} with retention ${schedule.retention}`,
      );
    }
  }

  const expectedIndexBySignature = new Map(
    manifest.indexes.map((index) => [indexSignature(index), index]),
  );
  const actualIndexBySignature = new Map<string, ActualFirestoreIndex[]>();
  for (const index of actualIndexes) {
    const signature = indexSignature(index);
    actualIndexBySignature.set(signature, [
      ...(actualIndexBySignature.get(signature) ?? []),
      index,
    ]);
  }
  for (const index of manifest.indexes) {
    const matches = actualIndexBySignature.get(indexSignature(index)) ?? [];
    if (matches.length === 0) {
      issues.push(`missing composite index ${describeIndex(index)}`);
    } else if (matches.length > 1) {
      issues.push(`duplicate composite index ${describeIndex(index)}`);
    } else if (matches[0]!.state !== "READY") {
      issues.push(
        `composite index ${describeIndex(index)} is ${matches[0]!.state}, not READY`,
      );
    }
  }
  for (const index of actualIndexes) {
    if (!expectedIndexBySignature.has(indexSignature(index))) {
      issues.push(`unexpected composite index ${describeIndex(index)}`);
    }
  }

  const expectedTtlBySignature = new Map(
    manifest.ttls.map((ttl) => [ttlSignature(ttl), ttl]),
  );
  const actualTtlBySignature = new Map<string, ActualFirestoreTtl[]>();
  for (const ttl of actualTtls) {
    const signature = ttlSignature(ttl);
    actualTtlBySignature.set(signature, [
      ...(actualTtlBySignature.get(signature) ?? []),
      ttl,
    ]);
  }
  for (const ttl of manifest.ttls) {
    const matches = actualTtlBySignature.get(ttlSignature(ttl)) ?? [];
    if (matches.length === 0) {
      issues.push(`missing TTL policy ${describeTtl(ttl)}`);
    } else if (matches.length > 1) {
      issues.push(`duplicate TTL policy ${describeTtl(ttl)}`);
    } else if (matches[0]!.state !== "ACTIVE") {
      issues.push(
        `TTL policy ${describeTtl(ttl)} is ${matches[0]!.state}, not ACTIVE`,
      );
    }
  }
  for (const ttl of actualTtls) {
    if (!expectedTtlBySignature.has(ttlSignature(ttl))) {
      issues.push(`unexpected TTL policy ${describeTtl(ttl)}`);
    }
  }

  return {
    databaseCount: manifest.databases.length,
    protectedDatabaseCount: actualDatabases.filter(
      (database) =>
        database.deleteProtectionState === "DELETE_PROTECTION_ENABLED",
    ).length,
    pitrEnabledDatabaseCount: actualDatabases.filter(
      (database) =>
        database.pointInTimeRecoveryEnablement ===
        "POINT_IN_TIME_RECOVERY_ENABLED",
    ).length,
    readyBackupScheduleCount: actualBackupSchedules.length,
    readyIndexCount: actualIndexes.filter((index) => index.state === "READY")
      .length,
    activeTtlCount: actualTtls.filter((ttl) => ttl.state === "ACTIVE").length,
    issues: [...new Set(issues)].sort(),
  };
};

const parseGcloudJson = (
  body: string,
  database: string,
  kind: string,
): unknown => {
  if (Buffer.byteLength(body, "utf8") > MAX_GCLOUD_JSON_BYTES) {
    throw new Error(
      `gcloud ${kind} JSON for ${database} exceeded the size limit`,
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`gcloud returned invalid ${kind} JSON for ${database}`);
  }
};

export type GcloudJsonRunner = (args: string[]) => string;

const runGcloudJson: GcloudJsonRunner = (args) => {
  try {
    return execFileSync("gcloud", args, {
      encoding: "utf8",
      maxBuffer: MAX_GCLOUD_JSON_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch {
    throw new Error("gcloud Firestore inventory command failed");
  }
};

export const collectFirestoreReadinessSnapshot = (
  manifest: FirestoreReadinessManifest,
  project: string,
  runner: GcloudJsonRunner = runGcloudJson,
): FirestoreReadinessSnapshot => {
  const databases: Record<string, FirestoreDatabaseSnapshot> = {};
  for (const expectedDatabase of manifest.databases) {
    const database = expectedDatabase.name;
    const common = [
      `--project=${project}`,
      `--database=${database}`,
      "--quiet",
    ];
    const databaseSettings = runner([
      "firestore",
      "databases",
      "describe",
      ...common,
      "--format=json(name,locationId,type,pointInTimeRecoveryEnablement,deleteProtectionState)",
    ]);
    const backupSchedules = runner([
      "firestore",
      "backups",
      "schedules",
      "list",
      ...common,
      "--format=json(name,retention,dailyRecurrence,weeklyRecurrence)",
    ]);
    const indexes = runner([
      "firestore",
      "indexes",
      "composite",
      "list",
      ...common,
      "--format=json(name,queryScope,state,fields)",
    ]);
    const ttls = runner([
      "firestore",
      "fields",
      "ttls",
      "list",
      ...common,
      "--format=json(name,ttlConfig.state)",
    ]);
    databases[database] = {
      database: parseGcloudJson(databaseSettings, database, "database"),
      backupSchedules: parseGcloudJson(
        backupSchedules,
        database,
        "backup-schedule",
      ),
      indexes: parseGcloudJson(indexes, database, "index"),
      ttls: parseGcloudJson(ttls, database, "TTL"),
    };
  }
  return { databases };
};

const parseArguments = (
  argv: string[],
): { project: string; locationId: string } => {
  if (
    argv.length !== 4 ||
    argv[0] !== "--project" ||
    argv[2] !== "--location"
  ) {
    throw new Error(
      "usage: npm run check:firestore-readiness -- --project PROJECT_ID --location LOCATION_ID",
    );
  }
  const project = argv[1]!;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) {
    throw new Error("PROJECT_ID is not a valid Google Cloud project ID");
  }
  const locationId = argv[3]!;
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(locationId)) {
    throw new Error("LOCATION_ID is not a valid Firestore location ID");
  }
  return { project, locationId };
};

export const main = (): void => {
  const { project, locationId } = parseArguments(process.argv.slice(2));
  const root = resolve(import.meta.dirname, "..");
  const source = readFileSync(resolve(root, "infra/opentofu/main.tf"), "utf8");
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = collectFirestoreReadinessSnapshot(manifest, project);
  const result = compareFirestoreReadiness(manifest, snapshot, project);
  if (result.issues.length > 0) {
    const shown = result.issues.slice(0, 50);
    const omitted = result.issues.length - shown.length;
    throw new Error(
      `managed Firestore is not ready:\n- ${shown.join("\n- ")}${
        omitted > 0 ? `\n- ${omitted} additional issue(s) omitted` : ""
      }`,
    );
  }
  process.stdout.write(
    `Managed Firestore is ready across ${result.databaseCount} databases (${result.protectedDatabaseCount} delete-protected, ${result.pitrEnabledDatabaseCount} with PITR enabled, ${result.readyBackupScheduleCount} backup schedules, ${result.readyIndexCount} composite indexes READY, ${result.activeTtlCount} TTL policies ACTIVE).\n`,
  );
};

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Firestore readiness check failed: ${message}\n`);
    process.exitCode = 1;
  }
}
