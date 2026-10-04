// Pure local helpers for the proposed n8n Code nodes. No network/database calls.
// On generation, inline these functions; do not require this file inside n8n.
export const workerPolicy = Object.freeze({
  version: 'phase2a-1', maxAudioBytes: 10000000, maxDurationSeconds: 600,
  leaseSeconds: 300, hardTtlHours: 72, successGraceHours: 1,
});
const categories = ['hardware', 'software', 'network', 'access', 'security', 'other', 'unknown'];
const priorities = ['low', 'normal', 'high', 'critical', 'unknown'];
const limits = {clientName: 300, company: 300, email: 254, summary: 200,
  description: 12000, affectedSystem: 1000, onsetText: 1000,
  businessImpact: 1000, urgencyEvidence: 1000};
const keys = [...Object.keys(limits), 'category', 'prioritySuggestion',
  'symptoms', 'technicalDetails', 'confidence', 'missingInformation'];
const problem = classification => Object.assign(new Error(classification), {classification});
const chars = s => Array.from(s).length;
const norm = s => s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function validateTranscript(value) {
  if (typeof value !== 'string' || !value.trim() || chars(value) > 100000 || value.includes('\0')) {
    throw problem('malformed_output');
  }
  return value; // Preserve whitespace, spelling, language, and punctuation exactly.
}

export function validateAudioMetadata(metadata) {
  if (!metadata || typeof metadata.fileId !== 'string' || !metadata.fileId.trim() ||
      typeof metadata.fileUniqueId !== 'string' || !metadata.fileUniqueId.trim() ||
      !Number.isInteger(metadata.durationSeconds) || metadata.durationSeconds < 0 ||
      metadata.durationSeconds > workerPolicy.maxDurationSeconds ||
      (metadata.declaredSizeBytes != null && (!Number.isSafeInteger(metadata.declaredSizeBytes) ||
        metadata.declaredSizeBytes < 1 || metadata.declaredSizeBytes > workerPolicy.maxAudioBytes)) ||
      (metadata.declaredMimeType != null && !['audio/ogg', 'audio/opus', 'application/ogg'].includes(metadata.declaredMimeType))) {
    throw problem('invalid_input');
  }
}

export function validateAudioBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > workerPolicy.maxAudioBytes ||
      buffer.subarray(0, 4).toString('ascii') !== 'OggS') throw problem('invalid_input');
  return {mimeType: 'audio/ogg', sizeBytes: buffer.length};
  // Container signature is a sanity check; the transcription provider validates decoding.
}

function validEmail(email) {
  if (email.length > 254 || /\s/u.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export function validateExtraction(output, transcript) {
  validateTranscript(transcript);
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).length !== keys.length || keys.some(k => !Object.hasOwn(output, k)) ||
      Object.keys(output).some(k => !keys.includes(k)) ||
      Buffer.byteLength(JSON.stringify(output), 'utf8') > 262144) throw problem('malformed_output');
  for (const [key, max] of Object.entries(limits)) {
    const value = output[key];
    if (value === null && !['summary', 'description'].includes(key)) continue;
    if (typeof value !== 'string' || !value.trim() || chars(value) > max || value.includes('\0')) {
      throw problem('malformed_output');
    }
  }
  if (output.category !== null && !categories.includes(output.category)) throw problem('malformed_output');
  if (output.prioritySuggestion !== null && !priorities.includes(output.prioritySuggestion)) throw problem('malformed_output');
  for (const key of ['symptoms', 'technicalDetails', 'missingInformation']) {
    const value = output[key];
    if (value === null) continue;
    if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' ||
        !item.trim() || chars(item) > 1000 || item.includes('\0'))) throw problem('malformed_output');
  }
  if (output.confidence !== null && (typeof output.confidence !== 'number' ||
      !Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1)) {
    throw problem('malformed_output');
  }
  if (output.email !== null && (!validEmail(output.email) ||
      !transcript.toLowerCase().includes(output.email.toLowerCase()))) throw problem('malformed_output');
  for (const key of ['clientName', 'company']) {
    if (output[key] !== null && !norm(transcript).includes(norm(output[key]))) throw problem('malformed_output');
  }
  return output; // No AI IDs, silent repairs, translation, priority approval, or identity writes.
}

export function classifyExternalFailure({stage, statusCode, timedOut = false, connectionLost = false}) {
  if (![ 'download', 'transcribe', 'extract' ].includes(stage)) return 'configuration';
  if ([401, 403].includes(statusCode)) return 'configuration';
  if (statusCode === 429 || (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599)) {
    return 'transient_external';
  }
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 499) return 'permanent_external';
  if (timedOut || connectionLost) return stage === 'download' ? 'transient_external' : 'provider_unknown_result';
  return 'provider_unknown_result'; // Do not copy provider messages, URLs, headers, or tokens.
}
