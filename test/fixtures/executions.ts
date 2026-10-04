export const fixtureSecrets = ['FAKE_API_KEY_DO_NOT_LEAK', 'FAKE_TOKEN_DO_NOT_LEAK', 'FAKE_PASSWORD_DO_NOT_LEAK', 'FAKE_COOKIE_DO_NOT_LEAK', 'FAKE_NESTED_DO_NOT_LEAK', 'FAKE_BODY_DO_NOT_LEAK', 'FAKE_PERSON_DO_NOT_LEAK'] as const;
export function executionFixture() {
  const error = {
    name: 'NodeApiError', message: 'Authorization failed - please check your credentials', httpCode: '401',
    description: 'Response body: FAKE_PERSON_DO_NOT_LEAK',
    node: { name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: { password: fixtureSecrets[2] } },
    authorization: `Bearer ${fixtureSecrets[1]}`, cookie: fixtureSecrets[3],
    request: { headers: { 'x-api-key': fixtureSecrets[0] }, body: { innocent: fixtureSecrets[5] } },
    response: { data: { person: fixtureSecrets[6] } },
    nested: { client_secret: fixtureSecrets[4] }, stack: fixtureSecrets.join(' '),
  };
  return {
    id: '123', workflowId: 'wf-1', status: 'error', mode: 'manual',
    startedAt: '2026-10-03T12:00:00.000Z', stoppedAt: '2026-10-03T12:00:01.000Z',
    data: { version: 1, resultData: { error, lastNodeExecuted: 'HTTP Request', runData: {
      Start: [{ executionStatus: 'success', executionTime: 1 }],
      'HTTP Request': [{ executionStatus: 'error', executionTime: 12, error, data: { main: [[{ json: { innocent: fixtureSecrets[5] }, binary: { data: fixtureSecrets[0] } }]] } }],
    } }, executionData: { contextData: { password: fixtureSecrets[2] } } },
    workflowData: { nodes: [error.node], credentials: { password: fixtureSecrets[2] } },
    customData: { innocent: fixtureSecrets[0] }, environment: { innocent: fixtureSecrets[4] },
  };
}
