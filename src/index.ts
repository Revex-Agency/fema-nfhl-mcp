import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---- Official FEMA NFHL ArcGIS REST endpoint ----
const NFHL_BASE =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer";

// Layer IDs from the official NFHL MapServer
const LAYER = {
  AVAILABILITY: 0,        // NFHL Availability — does this area have flood map coverage?
  LOMRS: 1,               // Letters of Map Revision
  FIRM_PANELS: 3,         // FIRM Panels (map panel index)
  BASE_FLOOD_ELEV: 16,    // Base Flood Elevation lines
  FLOOD_HAZARD_ZONES: 28, // Flood Hazard Zones (the main flood zone polygons)
  LOMAS: 34,              // Letters of Map Amendment (point features)
} as const;

// ---- Shared input schema ----
const LatLonInput = {
  lat: z
    .number()
    .min(-90)
    .max(90)
    .describe("Latitude in decimal degrees (WGS84)"),
  lon: z
    .number()
    .min(-180)
    .max(180)
    .describe("Longitude in decimal degrees (WGS84)"),
};

// ---- Query helpers ----

/** Point intersect query params */
function pointQuery(lat: number, lon: number): Record<string, string> {
  return {
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/**
 * Envelope (bounding box) query around a point.
 * Used for line and point layers where exact intersection is unlikely.
 * delta ≈ 0.001 deg ≈ 100m
 */
function envelopeQuery(
  lat: number,
  lon: number,
  delta = 0.001
): Record<string, string> {
  return {
    geometry: `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`,
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/** Core NFHL fetch function — throws on HTTP or API errors */
async function queryNFHL(
  layer: number,
  params: Record<string, string>
): Promise<{ features: Array<{ attributes: Record<string, unknown> }> }> {
  const url = new URL(`${NFHL_BASE}/${layer}/query`);
  const defaults: Record<string, string> = {
    f: "json",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "10",
    inSR: "4326",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...params })) {
    url.searchParams.set(k, v);
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "FloodZone-MCP/1.0",
    },
  });

  if (!resp.ok) {
    throw new Error(`FEMA NFHL HTTP ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  if (data["error"]) {
    const err = data["error"] as Record<string, unknown>;
    throw new Error(
      `FEMA NFHL error: ${err["message"] ?? JSON.stringify(err)}`
    );
  }

  return {
    features: Array.isArray(data["features"])
      ? (data["features"] as Array<{ attributes: Record<string, unknown> }>)
      : [],
  };
}

/** Format a potentially-null NFHL attribute value */
function fmt(val: unknown, unit?: string): string {
  if (val === null || val === undefined || val === "" || val === -9999) {
    return "N/A";
  }
  return unit ? `${val} ${unit}` : String(val);
}

/** Format an epoch-millisecond date returned by ArcGIS */
function fmtDate(val: unknown): string {
  if (typeof val !== "number" || val < 0) return "Unknown";
  return new Date(val).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---- MCP Server ----

const server = new McpServer({
  name: "fema-nfhl",
  version: "1.0.0",
});

// ---- Tool 1: Flood Zone Lookup ----
server.registerTool(
  "get_flood_zone",
  {
    description:
      "Look up the FEMA flood zone designation for a lat/lon coordinate using the official " +
      "National Flood Hazard Layer (NFHL). Returns the zone code (e.g. AE, X, VE, AO), " +
      "whether the location is in a Special Flood Hazard Area (SFHA), floodway status, " +
      "static BFE, and the FIRM panel citation. This is the primary tool for flood risk lookup.",
    inputSchema: LatLonInput,
  },
  async ({ lat, lon }) => {
    const { features } = await queryNFHL(LAYER.FLOOD_HAZARD_ZONES, pointQuery(lat, lon));

    if (features.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No FEMA flood zone found for (${lat}, ${lon}).\n` +
              "This location may be outside NFHL coverage or outside the United States.\n" +
              "Run check_nfhl_availability to confirm coverage.",
          },
        ],
      };
    }

    const a = features[0].attributes;
    const zone = fmt(a["FLD_ZONE"]);
    const zoneSub = a["ZONE_SUBTY"] && a["ZONE_SUBTY"] !== "" ? String(a["ZONE_SUBTY"]) : null;
    const sfha = a["SFHA_TF"] === "T" ? "Yes — High-risk flood zone" : a["SFHA_TF"] === "F" ? "No — Lower-risk area" : "Unknown";
    const floodway = fmt(a["FLOODWAY"]);
    const staticBfe =
      a["STATIC_BFE"] !== null && a["STATIC_BFE"] !== -9999
        ? `${a["STATIC_BFE"]} ${fmt(a["LEN_UNIT"])} (datum: ${fmt(a["V_DATUM"])})`
        : "N/A";
    const depth =
      (zone === "AO" || zone === "AH") && a["DEPTH"] !== null && a["DEPTH"] !== -9999
        ? `${a["DEPTH"]} ${fmt(a["LEN_UNIT"])}`
        : null;
    const source = fmt(a["SOURCE_CIT"]);

    const lines = [
      `Flood Zone:          ${zone}`,
      zoneSub ? `Zone Subtype:        ${zoneSub}` : null,
      `SFHA (high-risk):    ${sfha}`,
      `Floodway:            ${floodway}`,
      `Static BFE:          ${staticBfe}`,
      depth ? `Depth (AO/AH zone):  ${depth}` : null,
      `FIRM Source Panel:   ${source}`,
      `Features matched:    ${features.length}`,
      "",
      "── Zone Reference Guide ──────────────────────────────────",
      "  A / AE / AH / AO / AR   High-risk (SFHA) — mandatory flood insurance",
      "  VE / V                   High-risk coastal with wave action (SFHA)",
      "  X (shaded)               Moderate risk — 0.2% annual chance flood",
      "  X (unshaded)             Minimal risk",
      "  D                        Undetermined risk (no flood study done)",
    ]
      .filter((l) => l !== null)
      .join("\n");

    return { content: [{ type: "text" as const, text: lines }] };
  }
);

// ---- Tool 2: FIRM Panel Info ----
server.registerTool(
  "get_firm_panel",
  {
    description:
      "Get the FEMA FIRM (Flood Insurance Rate Map) panel number and metadata for a location. " +
      "Returns the official panel number, suffix, effective date, and panel type. " +
      "Use this to identify which flood map covers a location and when it was last updated.",
    inputSchema: LatLonInput,
  },
  async ({ lat, lon }) => {
    const { features } = await queryNFHL(LAYER.FIRM_PANELS, pointQuery(lat, lon));

    if (features.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No FIRM panel found for (${lat}, ${lon}). Area may lack NFHL coverage.`,
          },
        ],
      };
    }

    const panels = features.map((f, i) => {
      const a = f.attributes;
      const panelNum = `${fmt(a["FIRM_PAN"])}${fmt(a["SUFFIX"]) !== "N/A" ? fmt(a["SUFFIX"]) : ""}`;
      return [
        `Panel ${i + 1}:`,
        `  Panel Number:     ${panelNum}`,
        `  Effective Date:   ${fmtDate(a["EFF_DATE"])}`,
        `  Panel Type:       ${fmt(a["PANEL_TYP"])}`,
        a["PNP_REASON"] ? `  Note:             ${a["PNP_REASON"]}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `FIRM Panel(s) for (${lat}, ${lon}):\n\n${panels.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---- Tool 3: NFHL Coverage Check ----
server.registerTool(
  "check_nfhl_availability",
  {
    description:
      "Check whether the FEMA National Flood Hazard Layer (NFHL) has official flood map coverage " +
      "for a given location. Run this first if other tools return no data — it tells you whether " +
      "FEMA has mapped this area at all.",
    inputSchema: LatLonInput,
  },
  async ({ lat, lon }) => {
    const { features } = await queryNFHL(LAYER.AVAILABILITY, pointQuery(lat, lon));

    if (features.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No NFHL coverage found for (${lat}, ${lon}).\n` +
              "This area has not been mapped by FEMA or is outside the United States.\n" +
              "Flood insurance may still be available through the NFIP — contact FEMA or a local agent.",
          },
        ],
      };
    }

    const a = features[0].attributes;
    const lines = [
      `NFHL Coverage: Available`,
      `State FIPS:    ${fmt(a["STFIPS"])}`,
      `County FIPS:   ${fmt(a["COUNFIPS"])}`,
      `Jurisdiction:  ${fmt(a["LOCA_ABBRV"])}`,
    ].join("\n");

    return { content: [{ type: "text" as const, text: lines }] };
  }
);

// ---- Tool 4: Letters of Map Revision (LOMRs) ----
server.registerTool(
  "get_lomrs",
  {
    description:
      "Get Letters of Map Revision (LOMRs) that affect a location. LOMRs are official FEMA " +
      "revisions to the Flood Insurance Rate Map — they can change flood zone designations. " +
      "Returns case number, project name, effective date, and status for each revision.",
    inputSchema: LatLonInput,
  },
  async ({ lat, lon }) => {
    const { features } = await queryNFHL(LAYER.LOMRS, pointQuery(lat, lon));

    if (features.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No LOMRs found for (${lat}, ${lon}). No official map revisions affect this location.`,
          },
        ],
      };
    }

    const revisions = features.map((f, i) => {
      const a = f.attributes;
      return [
        `LOMR ${i + 1}:`,
        `  Case No:        ${fmt(a["CASE_NO"])}`,
        `  Project:        ${fmt(a["PROJECT_NA"])}`,
        `  Effective Date: ${fmtDate(a["EFF_DATE"])}`,
        `  Status:         ${fmt(a["STATUS"])}`,
      ].join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `LOMRs affecting (${lat}, ${lon}):\n\n${revisions.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---- Tool 5: Letters of Map Amendment (LOMAs) ----
server.registerTool(
  "get_lomas",
  {
    description:
      "Get Letters of Map Amendment (LOMAs) near a location. A LOMA is an official FEMA letter " +
      "that removes a specific structure or parcel from a Special Flood Hazard Area without " +
      "physically revising the Flood Insurance Rate Map. Searches within ~100m of the coordinate.",
    inputSchema: LatLonInput,
  },
  async ({ lat, lon }) => {
    // LOMAs are point features — use a small bounding box (~0.001 deg ≈ 100m)
    const { features } = await queryNFHL(LAYER.LOMAS, envelopeQuery(lat, lon, 0.001));

    if (features.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No LOMAs found near (${lat}, ${lon}). No map amendments exist for this location.`,
          },
        ],
      };
    }

    const amendments = features.map((f, i) => {
      const a = f.attributes;
      return [
        `LOMA ${i + 1}:`,
        `  Case No:        ${fmt(a["CASE_NO"])}`,
        `  Effective Date: ${fmtDate(a["EFF_DATE"])}`,
        `  Status:         ${fmt(a["STATUS"])}`,
        a["OUT_DATE"] ? `  Outcome Date:   ${fmtDate(a["OUT_DATE"])}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `LOMAs near (${lat}, ${lon}):\n\n${amendments.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---- Tool 6: Base Flood Elevations ----
server.registerTool(
  "get_base_flood_elevations",
  {
    description:
      "Get Base Flood Elevation (BFE) lines near a location from the NFHL. The BFE is the " +
      "elevation (in feet above datum) that floodwaters are expected to reach during a 1% " +
      "annual chance (100-year) flood. Critical for construction requirements and insurance rating. " +
      "Searches within ~100m of the coordinate. BFEs are not present in all flood zones (e.g. Zone X).",
    inputSchema: LatLonInput,
  },
  async ({ lat, lon }) => {
    // BFE lines are polylines — use an envelope to find nearby lines
    const { features } = await queryNFHL(
      LAYER.BASE_FLOOD_ELEV,
      envelopeQuery(lat, lon, 0.001)
    );

    if (features.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No Base Flood Elevation lines found near (${lat}, ${lon}).\n` +
              "BFEs are only present in studied flood zones (AE, VE, etc.).\n" +
              "Zone X and unstudied A zones typically have no BFE data.",
          },
        ],
      };
    }

    const bfes = features.map((f, i) => {
      const a = f.attributes;
      const elev =
        a["ELEV"] !== null && a["ELEV"] !== -9999
          ? `${a["ELEV"]} ${fmt(a["LEN_UNIT"])} (${fmt(a["V_DATUM"])})`
          : "N/A";
      return [
        `BFE Line ${i + 1}:`,
        `  Elevation: ${elev}`,
        `  Type:      ${fmt(a["BFE_LN_TYP"])}`,
        `  Source:    ${fmt(a["SOURCE_CIT"])}`,
      ].join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Base Flood Elevations near (${lat}, ${lon}):\n\n${bfes.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---- Start ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
