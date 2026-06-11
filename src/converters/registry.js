/**
 * Converter registry — register client (IDE) and provider (upstream API) handlers.
 *
 * Each converter may implement:
 *   convertRequest(ctx)  → ctx (mutate or return new ctx)
 *   convertResponse(ctx) → ctx  (non-streaming / buffered)
 *   transformResponseStream?(ctx, chunk) → chunk|null  (optional SSE/binary chunks)
 */

const CLIENT_CONVERTERS = Object.create(null);
const PROVIDER_CONVERTERS = Object.create(null);

function registerClientConverter(id, converter) {
  if (!id || !converter) return;
  CLIENT_CONVERTERS[id] = { id, ...converter };
}

function registerProviderConverter(id, converter) {
  if (!id || !converter) return;
  PROVIDER_CONVERTERS[id] = { id, ...converter };
}

function getClientConverter(clientTool) {
  return CLIENT_CONVERTERS[clientTool] || CLIENT_CONVERTERS._default || null;
}

function getProviderConverter(providerId) {
  return PROVIDER_CONVERTERS[providerId] || PROVIDER_CONVERTERS._default || null;
}

function listClientConverters() {
  return Object.keys(CLIENT_CONVERTERS).filter((k) => k !== "_default");
}

function listProviderConverters() {
  return Object.keys(PROVIDER_CONVERTERS).filter((k) => k !== "_default");
}

module.exports = {
  registerClientConverter,
  registerProviderConverter,
  getClientConverter,
  getProviderConverter,
  listClientConverters,
  listProviderConverters,
};
