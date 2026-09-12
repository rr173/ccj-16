async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  listProjects: () => request('GET', '/api/projects'),
  createProject: (name, author) => request('POST', '/api/projects', { name, author }),
  getProject: (id) => request('GET', `/api/projects/${id}`),
  getRevision: (revId) => request('GET', `/api/revisions/${revId}`),
  listRevisions: (id) => request('GET', `/api/projects/${id}/revisions`),
  listAudit: (id) => request('GET', `/api/projects/${id}/audit`),
  submit: (id, payload) => request('POST', `/api/projects/${id}/revisions`, payload),
  resolve: (id, payload) => request('POST', `/api/projects/${id}/resolve`, payload),
  importPreview: (id, payload) => request('POST', `/api/projects/${id}/import/preview`, payload),
  importCommit: (id, payload) => request('POST', `/api/projects/${id}/import/commit`, payload),
  importResolve: (id, payload) => request('POST', `/api/projects/${id}/import/resolve`, payload),
  importUndo: (id, payload) => request('POST', `/api/projects/${id}/import/undo`, payload),
};
