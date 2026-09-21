/**
 * Sample data — a synthetic file behind every data product.
 *
 * NOTHING HERE IS REAL. Every row is generated from a fixed seed, so the same
 * files come out on every run and every machine. Names, places, references
 * and numbers are made up to look plausible in a demo and to give the Purview
 * Data Map something to scan, classify and attach to the data products it
 * already describes — and to give Azure AI Search rows for an agent to cite.
 *
 * One folder per product in the sample-data container:
 *   <product-id>/<product-id>.csv    the data, header row first (Data Map
 *                                    extracts the schema from it)
 *   <product-id>/README.md           the data dictionary: every column, its
 *                                    type and meaning, plus the product's
 *                                    limitations, licence and sensitivity
 *
 * Column names are snake_case so they are valid AI Search field names and
 * survive the Data Map's header rules (non-empty, unique, not a date or a
 * number) unchanged.
 *
 *   node scripts/sample-data.js --out working/sample   write the files locally
 *   node scripts/sample-data.js --list                 show products and row counts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ----------------------------------------------------------- randomness */

/** mulberry32 — small, fast, deterministic. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function helpers(seed) {
  const r = rng(seed);
  const int = (a, b) => a + Math.floor(r() * (b - a + 1));
  const float = (a, b, dp = 2) => Number((a + r() * (b - a)).toFixed(dp));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const weighted = (pairs) => {
    const total = pairs.reduce((n, [, w]) => n + w, 0);
    let x = r() * total;
    for (const [v, w] of pairs) {
      x -= w;
      if (x <= 0) return v;
    }
    return pairs[pairs.length - 1][0];
  };
  const date = (from, to) => {
    const t = new Date(from).getTime() + r() * (new Date(to).getTime() - new Date(from).getTime());
    return new Date(t).toISOString().slice(0, 10);
  };
  const datetime = (from, to) => {
    const t = new Date(from).getTime() + r() * (new Date(to).getTime() - new Date(from).getTime());
    return new Date(Math.floor(t / 900000) * 900000).toISOString().replace('.000Z', 'Z');
  };
  const ref = (prefix, width) => `${prefix}${String(int(0, 10 ** width - 1)).padStart(width, '0')}`;
  const easting = () => int(150000, 655000);
  const northing = () => int(10000, 655000);
  return { r, int, float, pick, weighted, date, datetime, ref, easting, northing };
}

/* ------------------------------------------------------------ vocabulary */

const RIVERS = ['River Thames', 'River Severn', 'River Trent', 'River Ouse', 'River Wye', 'River Avon', 'River Tyne', 'River Exe', 'River Derwent', 'River Medway', 'River Tees', 'River Itchen'];
const COUNTIES = ['Cornwall', 'Devon', 'Somerset', 'Kent', 'Norfolk', 'Suffolk', 'Cumbria', 'Northumberland', 'Yorkshire', 'Lincolnshire', 'Shropshire', 'Herefordshire', 'Dorset', 'Sussex', 'Lancashire', 'Cheshire'];
const REGIONS = ['North East', 'North West', 'Yorkshire', 'East Midlands', 'West Midlands', 'East of England', 'London', 'South East', 'South West'];
const TOWNS = ['Ashford', 'Barnstaple', 'Carlisle', 'Dorchester', 'Exeter', 'Frome', 'Grantham', 'Hexham', 'Ipswich', 'Kendal', 'Lincoln', 'Malton', 'Newark', 'Oswestry', 'Penrith', 'Ripon', 'Shrewsbury', 'Taunton', 'Ulverston', 'Wells', 'Yeovil'];
const DETERMINANDS = [
  ['Ammoniacal Nitrogen as N', 'mg/l', 0.01, 2.5],
  ['Nitrate as N', 'mg/l', 0.5, 45],
  ['Orthophosphate, reactive as P', 'mg/l', 0.005, 1.2],
  ['Dissolved Oxygen', '% saturation', 40, 120],
  ['pH', 'pH units', 6.2, 8.9],
  ['Temperature of Water', 'cel', 2, 24],
  ['Conductivity at 25C', 'uS/cm', 80, 1400],
  ['Suspended Solids', 'mg/l', 1, 120],
  ['BOD ATU', 'mg/l', 0.5, 9]
];
const SPECIES_FISH = ['Cod', 'Haddock', 'Whiting', 'Plaice', 'Sole', 'Herring', 'Mackerel', 'Nephrops', 'Sprat', 'Lemon sole'];
const ICES = ['30E9', '31F0', '32F1', '33F2', '34F3', '35F4', '36F5', '37F6', '28E4', '29E5', '30E6', '27E8'];

/* --------------------------------------------------------------- products */

/**
 * Each product: columns (name, type, description) and a row generator that
 * receives the helpers and the row index. Types are what the dictionary
 * says; every CSV cell is text.
 */
export const SAMPLE_PRODUCTS = {
  'water-quality-archive': {
    rows: 1500,
    columns: [
      ['sample_id', 'string', 'Laboratory sample reference'],
      ['sampling_point_id', 'string', 'Sampling point notation'],
      ['sampling_point_name', 'string', 'Sampling point name'],
      ['water_body_type', 'string', 'River, Lake, Estuary or Groundwater'],
      ['sample_date', 'date', 'Date the sample was taken (ISO 8601)'],
      ['determinand', 'string', 'What was measured'],
      ['unit', 'string', 'Unit of the result'],
      ['result', 'number', 'Measured value'],
      ['result_qualifier', 'string', '< below detection limit, > above range, blank otherwise'],
      ['easting', 'integer', 'OSGB36 easting of the sampling point'],
      ['northing', 'integer', 'OSGB36 northing of the sampling point'],
      ['region', 'string', 'Environment Agency area']
    ],
    row: (h, i) => {
      const [det, unit, lo, hi] = h.pick(DETERMINANDS);
      const river = h.pick(RIVERS);
      const town = h.pick(TOWNS);
      return [
        `WQ-${String(2025000000 + i * 7).slice(-10)}`,
        h.ref('AN-', 6),
        `${river} at ${town}`,
        h.weighted([['River', 6], ['Lake', 1], ['Estuary', 1], ['Groundwater', 2]]),
        h.date('2025-01-01', '2026-08-31'),
        det,
        unit,
        h.float(lo, hi, 3),
        h.weighted([['', 9], ['<', 1]]),
        h.easting(),
        h.northing(),
        h.pick(REGIONS)
      ];
    }
  },

  'hydrology-flow-level': {
    rows: 1800,
    columns: [
      ['station_id', 'string', 'Telemetry station reference'],
      ['station_name', 'string', 'Station name'],
      ['river', 'string', 'River the station is on'],
      ['measure', 'string', 'Flow, Level or Rainfall'],
      ['timestamp', 'datetime', '15-minute reading time (UTC)'],
      ['value', 'number', 'Reading'],
      ['unit', 'string', 'm3/s for flow, mASD for level, mm for rainfall'],
      ['quality_flag', 'string', 'Good, Estimated or Missing'],
      ['catchment', 'string', 'Management catchment']
    ],
    row: (h) => {
      const measure = h.weighted([['Flow', 4], ['Level', 4], ['Rainfall', 2]]);
      const river = h.pick(RIVERS);
      const value = measure === 'Flow' ? h.float(0.2, 180, 3) : measure === 'Level' ? h.float(0.1, 4.5, 3) : h.float(0, 12, 1);
      return [
        h.ref('', 6),
        `${h.pick(TOWNS)} ${measure === 'Rainfall' ? 'rain gauge' : 'gauging station'}`,
        river,
        measure,
        h.datetime('2026-08-01', '2026-09-10'),
        value,
        measure === 'Flow' ? 'm3/s' : measure === 'Level' ? 'mASD' : 'mm',
        h.weighted([['Good', 17], ['Estimated', 2], ['Missing', 1]]),
        `${river.replace('River ', '')} ${h.pick(['Upper', 'Middle', 'Lower', 'Tidal'])}`
      ];
    }
  },

  'bathing-water-results': {
    rows: 900,
    columns: [
      ['bathing_water_id', 'string', 'Bathing water identifier (ukXXXXX-XXXXX)'],
      ['bathing_water_name', 'string', 'Designated bathing water'],
      ['county', 'string', 'County'],
      ['sample_date', 'date', 'Sample date'],
      ['ecoli_cfu_per_100ml', 'integer', 'Escherichia coli, colony-forming units per 100 ml'],
      ['intestinal_enterococci_cfu_per_100ml', 'integer', 'Intestinal enterococci, cfu per 100 ml'],
      ['classification', 'string', 'Annual classification: Excellent, Good, Sufficient or Poor'],
      ['season', 'integer', 'Bathing season year']
    ],
    row: (h) => {
      const county = h.pick(COUNTIES);
      const cls = h.weighted([['Excellent', 6], ['Good', 3], ['Sufficient', 1], ['Poor', 0.5]]);
      const scale = cls === 'Excellent' ? 1 : cls === 'Good' ? 2 : cls === 'Sufficient' ? 4 : 8;
      return [
        `uk${h.ref('', 5)}-${h.ref('', 5)}`,
        `${h.pick(TOWNS)} ${h.pick(['Sands', 'Beach', 'Bay', 'Cove', 'Harbour'])}`,
        county,
        h.date('2026-05-15', '2026-09-08'),
        h.int(10, 250 * scale),
        h.int(5, 100 * scale),
        cls,
        2026
      ];
    }
  },

  'catchment-land-cover': {
    rows: 700,
    columns: [
      ['catchment_id', 'string', 'Water Framework Directive catchment id'],
      ['catchment_name', 'string', 'Catchment name'],
      ['land_cover_class', 'string', 'Land cover class'],
      ['area_hectares', 'number', 'Area of the class within the catchment'],
      ['percent_of_catchment', 'number', 'Share of the catchment'],
      ['survey_year', 'integer', 'Year of the land cover survey'],
      ['source', 'string', 'Survey source']
    ],
    row: (h) => [
      h.ref('GB', 9),
      `${h.pick(RIVERS).replace('River ', '')} ${h.pick(['Upper', 'Lower', 'Vale', 'Tributaries'])}`,
      h.pick(['Arable', 'Improved grassland', 'Broadleaved woodland', 'Coniferous woodland', 'Heather', 'Urban', 'Suburban', 'Freshwater', 'Saltmarsh', 'Bog']),
      h.float(12, 9800, 1),
      h.float(0.2, 62, 1),
      h.pick([2021, 2023, 2025]),
      h.pick(['UKCEH Land Cover Map', 'Natural England field survey', 'Aerial interpretation'])
    ]
  },

  'rural-land-parcels': {
    rows: 1200,
    columns: [
      ['parcel_id', 'string', 'Land parcel identifier (synthetic)'],
      ['holding_reference', 'string', 'Holding reference (synthetic, not a real SBI)'],
      ['county', 'string', 'County'],
      ['area_hectares', 'number', 'Parcel area'],
      ['land_use', 'string', 'Declared land use'],
      ['scheme', 'string', 'Scheme the parcel is entered in'],
      ['agreement_start', 'date', 'Agreement start'],
      ['agreement_end', 'date', 'Agreement end'],
      ['status', 'string', 'Active, Under review or Ended']
    ],
    row: (h) => {
      const start = h.date('2022-01-01', '2026-06-30');
      return [
        `${h.pick(['SP', 'SU', 'TL', 'TQ', 'SD', 'SE', 'NY', 'SX'])}${h.ref('', 4)}${h.ref('', 4)}`,
        h.ref('SYN', 9),
        h.pick(COUNTIES),
        h.float(0.4, 48, 2),
        h.pick(['Permanent grassland', 'Temporary grassland', 'Arable', 'Woodland', 'Rough grazing', 'Orchard']),
        h.pick(['Sustainable Farming Incentive', 'Countryside Stewardship', 'Landscape Recovery', 'None']),
        start,
        new Date(new Date(start).getTime() + h.int(1, 5) * 365 * 86400000).toISOString().slice(0, 10),
        h.weighted([['Active', 8], ['Under review', 1], ['Ended', 1]])
      ];
    }
  },

  'livestock-movements': {
    rows: 1600,
    columns: [
      ['movement_id', 'string', 'Movement reference'],
      ['species', 'string', 'Cattle, Sheep or Pigs'],
      ['from_holding_cph', 'string', 'Departure holding CPH (synthetic)'],
      ['to_holding_cph', 'string', 'Destination holding CPH (synthetic)'],
      ['movement_date', 'date', 'Date of movement'],
      ['animal_count', 'integer', 'Animals moved'],
      ['movement_type', 'string', 'Farm to farm, To market, To slaughter or To show'],
      ['county_from', 'string', 'Departure county'],
      ['county_to', 'string', 'Destination county']
    ],
    row: (h, i) => {
      const species = h.weighted([['Cattle', 4], ['Sheep', 5], ['Pigs', 2]]);
      const cph = () => `${h.ref('', 2)}/${h.ref('', 3)}/${h.ref('', 4)}`;
      return [
        `MV-${String(900000 + i)}`,
        species,
        cph(),
        cph(),
        h.date('2026-01-01', '2026-09-09'),
        species === 'Sheep' ? h.int(5, 400) : species === 'Pigs' ? h.int(10, 250) : h.int(1, 60),
        h.weighted([['Farm to farm', 5], ['To market', 3], ['To slaughter', 3], ['To show', 0.5]]),
        h.pick(COUNTIES),
        h.pick(COUNTIES)
      ];
    }
  },

  'waste-carrier-registrations': {
    rows: 1400,
    columns: [
      ['registration_number', 'string', 'Carrier, broker or dealer registration (CBDU/CBDL)'],
      ['business_name', 'string', 'Registered business name (synthetic)'],
      ['tier', 'string', 'Upper or Lower tier'],
      ['registration_date', 'date', 'Date registered'],
      ['expiry_date', 'date', 'Expiry date (upper tier renews every 3 years)'],
      ['status', 'string', 'Active, Lapsed, Revoked or Pending'],
      ['region', 'string', 'Region of the registered address'],
      ['business_type', 'string', 'Sole trader, Partnership, Limited company or Public body']
    ],
    row: (h) => {
      const tier = h.weighted([['Upper', 6], ['Lower', 4]]);
      const reg = h.date('2021-01-01', '2026-08-31');
      const expiry = new Date(new Date(reg).getTime() + 3 * 365 * 86400000).toISOString().slice(0, 10);
      const lapsed = new Date(expiry) < new Date('2026-09-10');
      return [
        `${tier === 'Upper' ? 'CBDU' : 'CBDL'}${h.ref('', 6)}`,
        `${h.pick(['Ashby', 'Bridge', 'Castle', 'Downs', 'Elm', 'Fenland', 'Granite', 'Harbour', 'Kestrel', 'Meadow', 'Orchard', 'Pennine', 'Riverside', 'Saltway'])} ${h.pick(['Skips', 'Recycling', 'Haulage', 'Waste Services', 'Environmental', 'Clearances', 'Aggregates', 'Metals'])} ${h.pick(['Ltd', 'Limited', '', 'LLP'])}`.trim(),
        tier,
        reg,
        tier === 'Upper' ? expiry : '',
        tier === 'Upper' && lapsed ? h.weighted([['Lapsed', 7], ['Active', 3]]) : h.weighted([['Active', 14], ['Revoked', 0.5], ['Pending', 1]]),
        h.pick(REGIONS),
        h.weighted([['Limited company', 6], ['Sole trader', 3], ['Partnership', 1], ['Public body', 0.5]])
      ];
    }
  },

  'national-forest-inventory': {
    rows: 800,
    columns: [
      ['woodland_id', 'string', 'Inventory woodland identifier'],
      ['woodland_name', 'string', 'Woodland name'],
      ['country_region', 'string', 'Region'],
      ['area_hectares', 'number', 'Woodland area'],
      ['woodland_type', 'string', 'Broadleaved, Conifer, Mixed or Felled'],
      ['interpreted_forest_type', 'string', 'Interpreted forest type'],
      ['survey_year', 'integer', 'Year surveyed'],
      ['ownership', 'string', 'Public or Private']
    ],
    row: (h) => [
      h.ref('NFI', 7),
      `${h.pick(TOWNS)} ${h.pick(['Wood', 'Forest', 'Copse', 'Plantation', 'Hanger', 'Coppice'])}`,
      h.pick(REGIONS),
      h.float(0.5, 640, 1),
      h.weighted([['Broadleaved', 5], ['Conifer', 3], ['Mixed', 2], ['Felled', 0.3]]),
      h.pick(['Oak', 'Beech', 'Ash', 'Sitka spruce', 'Scots pine', 'Birch', 'Mixed broadleaved', 'Larch', 'Douglas fir']),
      h.pick([2022, 2023, 2024, 2025]),
      h.weighted([['Private', 7], ['Public', 3]])
    ]
  },

  'marine-catch-returns': {
    rows: 1000,
    columns: [
      ['survey_id', 'string', 'Survey reference'],
      ['vessel_id', 'string', 'Survey vessel (synthetic)'],
      ['survey_date', 'date', 'Date of the haul'],
      ['ices_rectangle', 'string', 'ICES statistical rectangle'],
      ['species', 'string', 'Species'],
      ['catch_kg', 'number', 'Catch weight, kilograms'],
      ['gear_type', 'string', 'Gear'],
      ['sea_area', 'string', 'Sea area']
    ],
    row: (h) => [
      h.ref('SRV', 6),
      h.pick(['CEFAS ENDEAVOUR', 'RV CORYSTES', 'RV PRINCE MADOG', 'FV SYNTHETIC 1', 'FV SYNTHETIC 2']),
      h.date('2025-09-01', '2026-08-31'),
      h.pick(ICES),
      h.pick(SPECIES_FISH),
      h.float(2, 1800, 1),
      h.pick(['Otter trawl', 'Beam trawl', 'Gill net', 'Pots', 'Pelagic trawl']),
      h.pick(['North Sea', 'English Channel', 'Celtic Sea', 'Irish Sea', 'Bristol Channel'])
    ]
  },

  'flood-risk-model-outputs': {
    rows: 1500,
    columns: [
      ['cell_id', 'string', 'Model grid cell'],
      ['easting', 'integer', 'OSGB36 easting of the cell centre'],
      ['northing', 'integer', 'OSGB36 northing of the cell centre'],
      ['scenario', 'string', 'Return period scenario'],
      ['flood_source', 'string', 'River, Sea or Surface water'],
      ['depth_m', 'number', 'Modelled maximum depth, metres'],
      ['probability_band', 'string', 'High, Medium, Low or Very low'],
      ['model_version', 'string', 'Model run identifier'],
      ['local_authority', 'string', 'Local authority']
    ],
    row: (h) => {
      const scenario = h.pick(['1 in 30', '1 in 100', '1 in 1000']);
      return [
        h.ref('C', 8),
        h.easting(),
        h.northing(),
        scenario,
        h.weighted([['River', 5], ['Surface water', 4], ['Sea', 1]]),
        h.float(0.05, scenario === '1 in 1000' ? 3.2 : 1.6, 2),
        scenario === '1 in 30' ? 'High' : scenario === '1 in 100' ? 'Medium' : h.pick(['Low', 'Very low']),
        h.pick(['RoFRS v2.3', 'RoFSW v3.1', 'NaFRA2 2025.1']),
        `${h.pick(TOWNS)} ${h.pick(['District', 'Borough', 'City', 'County'])} Council`
      ];
    }
  },

  'ammonia-emissions-grid': {
    rows: 1200,
    columns: [
      ['grid_cell_id', 'string', '1 km grid cell'],
      ['easting', 'integer', 'OSGB36 easting of the cell'],
      ['northing', 'integer', 'OSGB36 northing of the cell'],
      ['year', 'integer', 'Inventory year'],
      ['ammonia_tonnes', 'number', 'Estimated NH3 emissions, tonnes per year'],
      ['source_sector', 'string', 'Cattle, Pigs, Poultry, Fertiliser, Other agriculture or Non-agricultural'],
      ['uncertainty_percent', 'number', 'Estimated uncertainty'],
      ['region', 'string', 'Region']
    ],
    row: (h) => [
      `${h.pick(['SP', 'SU', 'TL', 'TQ', 'SD', 'SE', 'NY', 'SX', 'SK', 'TF'])}${h.ref('', 2)}${h.ref('', 2)}`,
      h.easting(),
      h.northing(),
      h.pick([2022, 2023, 2024]),
      h.float(0.01, 14, 3),
      h.weighted([['Cattle', 5], ['Pigs', 1], ['Poultry', 2], ['Fertiliser', 3], ['Other agriculture', 1], ['Non-agricultural', 1]]),
      h.float(15, 60, 0),
      h.pick(REGIONS)
    ]
  },

  'servicenow-incidents': {
    rows: 1300,
    columns: [
      ['incident_number', 'string', 'Incident reference'],
      ['opened_at', 'datetime', 'When the incident was raised (UTC)'],
      ['resolved_at', 'datetime', 'When it was resolved, blank if open'],
      ['priority', 'string', 'P1 to P4'],
      ['category', 'string', 'Category'],
      ['service', 'string', 'Business service affected'],
      ['assignment_group', 'string', 'Resolving team'],
      ['state', 'string', 'New, In progress, Resolved or Closed'],
      ['sla_met', 'string', 'Yes or No']
    ],
    row: (h, i) => {
      const opened = h.datetime('2026-06-01', '2026-09-09');
      const state = h.weighted([['Closed', 6], ['Resolved', 2], ['In progress', 1.5], ['New', 0.5]]);
      const resolved = /Resolved|Closed/.test(state) ? new Date(new Date(opened).getTime() + h.int(1, 72) * 3600000).toISOString().replace('.000Z', 'Z') : '';
      return [
        `INC${String(1000000 + i)}`,
        opened,
        resolved,
        h.weighted([['P1', 0.3], ['P2', 1], ['P3', 5], ['P4', 4]]),
        h.pick(['Access', 'Hardware', 'Software', 'Network', 'Email', 'Telephony', 'Printing', 'Data']),
        h.pick(['Email and calendar', 'Identity', 'Field mobile app', 'Permitting portal', 'Finance system', 'GIS platform', 'Corporate network']),
        h.pick(['Service desk', 'End user compute', 'Network operations', 'Application support', 'Identity and access', 'Cloud platform']),
        state,
        h.weighted([['Yes', 8], ['No', 2]])
      ];
    }
  },

  'finance-ledger': {
    rows: 1100,
    columns: [
      ['ledger_id', 'string', 'Ledger line reference'],
      ['cost_centre', 'string', 'Cost centre (synthetic)'],
      ['programme', 'string', 'Programme'],
      ['portfolio', 'string', 'Portfolio'],
      ['period', 'string', 'Accounting period, YYYY-MM'],
      ['budget_gbp', 'number', 'Budget for the period'],
      ['actual_gbp', 'number', 'Actual spend for the period'],
      ['variance_gbp', 'number', 'Actual minus budget'],
      ['spend_type', 'string', 'Capital or Resource']
    ],
    row: (h, i) => {
      const budget = h.int(5000, 950000);
      const actual = Math.round(budget * h.float(0.7, 1.25, 3));
      return [
        `GL-${String(500000 + i)}`,
        h.ref('CC', 5),
        h.pick(['Flood defence capital', 'Environmental land management', 'Water quality monitoring', 'Digital data and technology', 'Animal health surveillance', 'Marine science', 'Air quality', 'Estates']),
        h.pick(['Environment', 'Farming', 'Digital', 'Corporate', 'Marine']),
        `${h.pick([2025, 2026])}-${String(h.int(1, 12)).padStart(2, '0')}`,
        budget,
        actual,
        actual - budget,
        h.weighted([['Resource', 7], ['Capital', 3]])
      ];
    }
  },

  'endpoint-telemetry': {
    rows: 1500,
    columns: [
      ['device_id', 'string', 'Device identifier (synthetic)'],
      ['os', 'string', 'Operating system and version'],
      ['device_model', 'string', 'Model'],
      ['boot_time_seconds', 'integer', 'Average time to desktop'],
      ['cpu_avg_percent', 'number', 'Average CPU use over 30 days'],
      ['memory_avg_percent', 'number', 'Average memory use over 30 days'],
      ['crashes_last_30d', 'integer', 'Application crashes in the last 30 days'],
      ['site', 'string', 'Office or Remote'],
      ['last_seen', 'date', 'Last check-in']
    ],
    row: (h) => [
      h.ref('DEV-', 7),
      h.weighted([['Windows 11 24H2', 6], ['Windows 11 23H2', 3], ['macOS 15', 1]]),
      h.pick(['Surface Laptop 6', 'Surface Pro 10', 'Latitude 5450', 'ThinkPad T14', 'MacBook Air M3', 'EliteBook 840']),
      h.int(18, 190),
      h.float(8, 72, 1),
      h.float(35, 92, 1),
      h.weighted([[0, 6], [1, 2], [2, 1], [h.int(3, 9), 1]]),
      h.weighted([['Remote', 6], [`${h.pick(TOWNS)} office`, 4]]),
      h.date('2026-08-15', '2026-09-10')
    ]
  }
};

/* -------------------------------------------------------------- output */

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A stable seed per product, so every product's file is different and repeatable. */
function seedFor(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Generate one product's files.
 * @param {string} id        the product id (folder name)
 * @param {object} product   the data product record from bootstrap/data-products.json, for the dictionary
 * @param {object} [opts]    { rows } to override the row count
 */
export function generateProduct(id, product = {}, { rows } = {}) {
  const spec = SAMPLE_PRODUCTS[id];
  if (!spec) throw new Error(`No sample generator for ${id}`);
  const h = helpers(seedFor(id));
  const count = rows ?? spec.rows;
  const columns = spec.columns.map(([name, type, description]) => ({ name, type, description }));
  const lines = [columns.map((c) => c.name).join(',')];
  for (let i = 0; i < count; i++) lines.push(spec.row(h, i).map(csvCell).join(','));
  const csv = lines.join('\n') + '\n';

  const readme = `# ${product.name || id} — sample data

> **SYNTHETIC DATA.** Every row in \`${id}.csv\` was generated by \`scripts/sample-data.js\` from a fixed seed.
> No real people, holdings, businesses, devices or measurements appear here. It exists so that the
> Purview Data Map has a real file to scan and attach to the **${product.name || id}** data product,
> and so that an agent built on the product has rows to cite.

${product.description || ''}

| | |
|---|---|
| Data product | ${product.name || id} |
| Governance domain | ${product.domain || '—'} |
| Rows | ${count.toLocaleString('en-GB')} |
| Sensitivity | ${product.sensitivity || 'Official'} |
| Licence | ${product.licence || '—'} |
| Access route | ${product.accessRoute || '—'} |
| Update frequency (as described) | ${product.updateFrequency || '—'} |
| Minimum aggregation | ${product.minimumAggregation || 'None stated'} |

## Columns

| Column | Type | Meaning |
|---|---|---|
${columns.map((c) => `| \`${c.name}\` | ${c.type} | ${c.description} |`).join('\n')}

## Limitations

${product.limitations || product.businessUse || 'Synthetic data has no limitations worth stating beyond the fact that it is synthetic.'}

## Depends on

${(product.dependsOn || []).length ? product.dependsOn.map((d) => `- ${d}`).join('\n') : '- None recorded'}
`;

  return { id, csv, readme, columns, rowCount: count, bytes: Buffer.byteLength(csv, 'utf8') };
}

export function sampleProductIds() {
  return Object.keys(SAMPLE_PRODUCTS);
}

/* ------------------------------------------------------------------ cli */

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const out = args.find((a) => a.startsWith('--out='))?.split('=')[1] || (args.includes('--out') ? args[args.indexOf('--out') + 1] : null);
  if (args.includes('--list') || !out) {
    for (const id of sampleProductIds()) {
      const g = generateProduct(id);
      console.log(`${id.padEnd(30)} ${String(g.rowCount).padStart(5)} rows  ${g.columns.length} columns  ${(g.bytes / 1024).toFixed(0).padStart(4)} KB`);
    }
    if (!out) console.log('\nWrite the files with:  node scripts/sample-data.js --out <folder>');
  } else {
    for (const id of sampleProductIds()) {
      const g = generateProduct(id);
      const dir = path.join(out, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${id}.csv`), g.csv);
      writeFileSync(path.join(dir, 'README.md'), g.readme);
      console.log(`wrote ${dir} (${g.rowCount} rows)`);
    }
  }
}
