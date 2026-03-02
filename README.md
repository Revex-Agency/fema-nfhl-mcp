# FEMA NFHL MCP Server

An MCP (Model Context Protocol) server that gives AI assistants direct access to the **FEMA National Flood Hazard Layer (NFHL)** — the official source for flood zone data in the United States.

Built on the [official FEMA ArcGIS REST API](https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer).

---

## Tools

| Tool | Description |
|------|-------------|
| `get_flood_zone` | Look up the FEMA flood zone for a lat/lon. Returns zone code (AE, X, VE, etc.), SFHA status, floodway, BFE, and FIRM source panel. |
| `get_firm_panel` | Get the FIRM (Flood Insurance Rate Map) panel number and effective date for a location. |
| `check_nfhl_availability` | Check whether FEMA has NFHL flood map coverage for a location. |
| `get_lomrs` | Get Letters of Map Revision (LOMRs) affecting a location. |
| `get_lomas` | Get Letters of Map Amendment (LOMAs) near a location. |
| `get_base_flood_elevations` | Get Base Flood Elevation (BFE) lines near a location. |

---

## Requirements

- Node.js 18+
- npm

---

## Installation

```bash
git clone https://github.com/Revex-Agency/fema-nfhl-mcp.git
cd fema-nfhl-mcp
npm install
npm run build
```

---

## Usage

### Cursor

Add to your `.cursor/config.json`:

```json
{
  "mcpServers": {
    "floodzone": {
      "command": "node",
      "args": ["C:\\path\\to\\fema-nfhl-mcp\\dist\\index.js"]
    }
  }
}
```

### Claude Desktop

Add to `%AppData%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "floodzone": {
      "command": "node",
      "args": ["/absolute/path/to/fema-nfhl-mcp/dist/index.js"]
    }
  }
}
```

### Development (no build step)

```json
{
  "mcpServers": {
    "floodzone": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"]
    }
  }
}
```

---

## Data Source

All data is sourced in real time from the **official FEMA NFHL ArcGIS REST service**:

```
https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer
```

No API key required. No data is stored or cached locally.

---

## Flood Zone Reference

| Zone | Description |
|------|-------------|
| A / AE / AH / AO / AR | High-risk flood zone (SFHA) — mandatory flood insurance for federally-backed mortgages |
| VE / V | High-risk coastal zone with wave action (SFHA) |
| X (shaded) | Moderate risk — 0.2% annual chance flood |
| X (unshaded) | Minimal risk |
| D | Undetermined risk (area not studied) |

---

## License

MIT
