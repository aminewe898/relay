import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateTranscript, validateExtraction, validateAudioBytes,
  validateAudioMetadata, classifyExternalFailure} from './phase2a-validators.mjs';
const extraction = () => ({clientName:null,company:null,email:null,summary:'FAKE TEST',
  description:'FAKE TEST incident.',category:'unknown',prioritySuggestion:'unknown',
  affectedSystem:null,symptoms:null,technicalDetails:null,onsetText:null,businessImpact:null,
  urgencyEvidence:null,confidence:null,missingInformation:['email']});
test('original Spanish/Catalan/English/Arabic transcript preserved exactly', () => {
  for (const text of ['  El equipo no arranca.\n', '  L’ordinador no arrenca.\n',
    '  The computer does not start.\n', '  الحاسوب لا يعمل.\n']) assert.equal(validateTranscript(text), text);
});
test('unusable transcript rejected', () => {
  for (const value of ['', '  ', null, 'a\0b']) assert.throws(() => validateTranscript(value));
});
test('extra IDs, missing keys, bad types, bounds and confidence rejected', () => {
  const fixtures=[{...extraction(),clientId:'FAKE-ID'}, {...extraction(),confidence:2},
    {...extraction(),technicalDetails:[42]}, {...extraction(),summary:null},
    {...extraction(),description:'x'.repeat(12001)}, {...extraction(),prioritySuggestion:'urgent'}];
  const missing=extraction(); delete missing.email; fixtures.push(missing);
  for (const value of fixtures) assert.throws(() => validateExtraction(value,'FAKE TEST incident.'));
});
test('null optional data is accepted without changing output', () => {
  const value=extraction(); assert.equal(validateExtraction(value,'FAKE TEST incident.'),value);
});
test('invented or malformed identity evidence rejected', () => {
  assert.throws(() => validateExtraction({...extraction(),email:'fake@example.invalid'},'FAKE TEST incident.'));
  assert.throws(() => validateExtraction({...extraction(),clientName:'Invented Person'},'FAKE TEST incident.'));
  assert.throws(() => validateExtraction({...extraction(),email:'.bad@example.invalid'},'.bad@example.invalid'));
  const value={...extraction(),clientName:'Persona Ficticia',company:'Empresa Ficticia',email:'fake@example.invalid'};
  assert.equal(validateExtraction(value,'Persona Ficticia de Empresa Ficticia: fake@example.invalid'),value);
});
test('audio size, declared bounds and signature checked using mock bytes only', () => {
  assert.equal(validateAudioBytes(Buffer.from('OggSFAKE-UNIT-FIXTURE')).mimeType,'audio/ogg');
  assert.throws(() => validateAudioBytes(Buffer.alloc(10000001)));
  assert.throws(() => validateAudioBytes(Buffer.from('not-ogg')));
  const base={fileId:'FAKE',fileUniqueId:'FAKE-UNIQUE',durationSeconds:3,declaredSizeBytes:100};
  validateAudioMetadata(base);
  assert.throws(() => validateAudioMetadata({...base,declaredSizeBytes:10000001}));
  assert.throws(() => validateAudioMetadata({...base,durationSeconds:601}));
});
test('failure classifications are conservative, without provider error text', () => {
  assert.equal(classifyExternalFailure({stage:'download',statusCode:400}),'permanent_external');
  assert.equal(classifyExternalFailure({stage:'extract',statusCode:429}),'transient_external');
  assert.equal(classifyExternalFailure({stage:'transcribe',statusCode:401}),'configuration');
  assert.equal(classifyExternalFailure({stage:'download',timedOut:true}),'transient_external');
  assert.equal(classifyExternalFailure({stage:'transcribe',timedOut:true}),'provider_unknown_result');
  assert.equal(classifyExternalFailure({stage:'resolve_client',statusCode:500}),'configuration');
});
