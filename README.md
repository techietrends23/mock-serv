# Mock Serv

Mock Serv is a local-first web app for importing API definitions and generating configurable mock servers.

The browser UI runs in Vite. A local Node API runs beside it and is responsible for:

- importing OpenAPI, cURL, Postman, and HAR definitions
- persisting mocks and rows in SQLite
- starting and stopping local REST or GraphQL mock servers
- exposing logs and seeded data back to the UI

## What This Repo Contains

- `apps/desktop` - browser UI built with React and Vite
- `apps/server` - local Node API that wraps `MockService`
- `packages/core` - shared importers, SQLite repository, runtime manager, and schema helpers
- `petstore.yaml` - OpenAPI sample used for verification

## Tech Stack

- React + TypeScript for the web UI
- Vite for the frontend dev server and build
- Fastify for the local API server and REST mocks
- GraphQL Yoga for GraphQL mocks
- `better-sqlite3` for local SQLite persistence
- `@apidevtools/swagger-parser` and `yaml` for OpenAPI parsing

## Requirements

- Node.js 20+ recommended
- npm 10+ recommended
- macOS, Windows, or Linux

## Setup

1. Install dependencies:

```bash
npm install
```

2. Verify the workspace:

```bash
npm run check
```

3. Run the test suite:

```bash
npm test
```

## Run In Development

Start the local API and browser UI together:

```bash
npm run dev
```

This starts:

- the local API on `http://127.0.0.1:3001`
- the Vite web UI on `http://127.0.0.1:5173`

Open `http://127.0.0.1:5173` in your browser.

The Vite dev server proxies `/api/*` requests to the local backend, so the UI and backend behave like one app during development.

## Run As A Built Web App

Build the frontend bundle:

```bash
npm run build
```

Then start the local API with the built UI served from the same process:

```bash
npm run start
```

By default this serves the app from `http://127.0.0.1:3001`.

## Available Scripts

- `npm run dev` - run the local API and browser UI together
- `npm run dev:api` - run only the local API server
- `npm run dev:web` - run only the Vite frontend
- `npm run start` - build the frontend and serve the built UI from the local API
- `npm run build` - run checks and build the web UI
- `npm run build:web` - build the Vite frontend bundle
- `npm run build:renderer` - alias for `npm run build:web`
- `npm run check` - typecheck core, web UI, and local API
- `npm run check:core` - typecheck the shared core package
- `npm run check:web` - typecheck the React frontend
- `npm run check:server` - typecheck the local API server
- `npm run test` - run the Vitest suite
- `npm run verify:petstore` - run an end-to-end backend verification using `petstore.yaml`

## How To Use The App

### 1. Open the web UI

Run:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

### 2. Import an API definition

Use the Import panel to either:

- upload a local file
- paste a definition directly

Supported sources:

- OpenAPI / Swagger YAML or JSON
- cURL
- Postman Collection JSON
- HAR JSON

### 3. Enter a mock name

The mock name is required before the imported definition is persisted.

It is used to:

- identify the mock in the UI
- generate SQLite table names for endpoint data
- keep multiple imported mocks separated

### 4. Analyze and import

Click `Analyze and Import`.

The local API will:

- parse the input
- create a mock definition
- persist the mock in SQLite
- generate endpoint metadata for editing and runtime use

### 5. Start the mock

Click `Start` from the Available Mocks panel.

The backend will:

- assign a port if one is not already configured
- boot a local HTTP mock server
- register all imported routes
- begin serving schema-generated or seeded responses

### 6. Edit and save

Use the editor to:

- update mock-level latency and error rates
- change endpoint method, path, and name
- edit request headers
- modify request and response schemas
- add or remove endpoints
- seed CRUD rows for generated responses

When you save a mock, the backend persists the changes and hot-reloads the runtime if that mock is running.

### 7. Inspect logs and runtime state

The inspector shows:

- current runtime status
- assigned port
- endpoint count
- endpoint metadata
- recent logs

## Local Data Storage

Mock Serv stores data in a repo-local directory by default:

```text
.mock-serv-data/workspace.sqlite
```

That database includes:

- mock definitions
- endpoint definitions
- CRUD-backed rows
- request and runtime logs

You can override the storage location with:

```bash
MOCK_SERV_DATA_DIR=/absolute/or/relative/path
```

## Petstore Walkthrough

This repository includes `petstore.yaml`, a full OpenAPI 3 Petstore spec.

To verify the app manually with that file:

1. Start the app:

```bash
npm run dev
```

2. Open `http://127.0.0.1:5173`.

3. In the Import panel, set:

- Source: `OpenAPI / Swagger`
- Protocol: `REST`

4. Upload `petstore.yaml` or paste its contents.

5. Enter a mock name such as:

```text
petstore-local
```

6. Click `Analyze and Import`.

7. Click `Start` for the imported mock.

8. Use the assigned port to call routes such as:

```bash
curl http://127.0.0.1:<port>/pet/findByStatus?status=available
curl http://127.0.0.1:<port>/pet/1
curl -X POST http://127.0.0.1:<port>/pet -H 'content-type: application/json' -d '{"id":1,"name":"Fluffy","status":"available"}'
curl -X PUT http://127.0.0.1:<port>/pet -H 'content-type: application/json' -d '{"id":1,"name":"Fluffy","status":"sold"}'
curl http://127.0.0.1:<port>/store/inventory
```

Expected behavior:

- `GET /pet/findByStatus` returns a generated array of pets
- `GET /pet/{petId}` returns a generated pet payload
- `POST /pet` stores and returns the posted pet
- `PUT /pet` updates and returns the new pet state
- `GET /store/inventory` returns a generated object payload

## Automated Verification

Run:

```bash
npm run verify:petstore
```

This script:

- starts the local API against a temporary data directory
- parses and imports `petstore.yaml`
- starts the generated mock runtime
- calls `GET /pet/findByStatus?status=available`
- asserts a `200` response with an array payload

## Troubleshooting

### The UI loads but actions fail

- Make sure you started both frontend and backend with `npm run dev`
- Confirm the API is reachable at `http://127.0.0.1:3001/api/health`
- If you are running only the frontend, UI actions that depend on the backend will fail by design

### The frontend cannot connect to the backend

- Check whether port `3001` is already in use
- Restart with `npm run dev`
- If needed, run the backend directly with:

```bash
npm run dev:api
```

### OpenAPI import fails

- The importer expects a valid OpenAPI or Swagger document
- YAML files are supported directly
- If a `$ref` points to external content, that target must be resolvable locally or over the network

## Verification Status

The repository is intended to be verified with:

- `npm run check`
- `npm test`
- `npm run build:web`
- `npm run verify:petstore`
