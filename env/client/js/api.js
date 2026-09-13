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
  // ---- 交付质检与发布快照 ----
  qcGetRules: (id) => request('GET', `/api/projects/${id}/qc/rules`),
  qcPutRules: (id, payload) => request('PUT', `/api/projects/${id}/qc/rules`, payload),
  qcStartJob: (id, payload) => request('POST', `/api/projects/${id}/qc/jobs`, payload),
  qcListJobs: (id) => request('GET', `/api/projects/${id}/qc/jobs`),
  qcGetJob: (id, jobId) => request('GET', `/api/projects/${id}/qc/jobs/${jobId}`),
  qcCancelJob: (id, jobId, author) => request('POST', `/api/projects/${id}/qc/jobs/${jobId}/cancel`, { author }),
  qcFindings: (id, jobId, q = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    return request('GET', `/api/projects/${id}/qc/jobs/${jobId}/findings${qs ? '?' + qs : ''}`);
  },
  qcFinding: (id, findingId) => request('GET', `/api/projects/${id}/qc/findings/${findingId}`),
  qcCueHistory: (id, cueId) => request('GET', `/api/projects/${id}/qc/cues/${cueId}/history`),
  qcDecide: (id, payload) => request('POST', `/api/projects/${id}/qc/findings/decide`, payload),
  qcFix: (id, payload) => request('POST', `/api/projects/${id}/qc/findings/fix`, payload),
  releasePreflight: (id, revisionId) => request('GET', `/api/projects/${id}/releases/preflight?revisionId=${revisionId}`),
  releaseRequestCreate: (id, payload) => request('POST', `/api/projects/${id}/release-requests`, payload),
  releaseRequestList: (id) => request('GET', `/api/projects/${id}/release-requests`),
  releaseApprove: (rid, payload) => request('POST', `/api/release-requests/${rid}/approve`, payload),
  releaseReject: (rid, payload) => request('POST', `/api/release-requests/${rid}/reject`, payload),
  releasePublish: (id, payload) => request('POST', `/api/projects/${id}/releases`, payload),
  releaseList: (id) => request('GET', `/api/projects/${id}/releases`),
  releaseWithdraw: (rid, payload) => request('POST', `/api/releases/${rid}/withdraw`, payload),
  releaseDiff: (rid, against) => request('GET', `/api/releases/${rid}/diff?against=${against}`),
  // ---- 版本差异报告 ----
  diffReportCreate: (id, payload) => request('POST', `/api/projects/${id}/diff-reports`, payload),
  diffReportList: (id) => request('GET', `/api/projects/${id}/diff-reports`),
  diffReportGet: (rid, q = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    return request('GET', `/api/diff-reports/${rid}${qs ? '?' + qs : ''}`);
  },
  diffReportDelete: (rid, author) => request('DELETE', `/api/diff-reports/${rid}`, { author }),
};
