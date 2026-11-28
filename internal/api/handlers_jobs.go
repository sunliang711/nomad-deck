package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/db"
	"nomad-deck/internal/integration"
	"nomad-deck/internal/jobs"
	"nomad-deck/internal/jobspec"
	"nomad-deck/internal/vault"
)

// jobRef reads the cluster, namespace and job ID of a job route. The job
// ID is URL-encoded as a whole (periodic and dispatched children contain
// "/"); routing matches the raw path, so it is decoded here.
func jobRef(r *http.Request) (clusterID, namespace, jobID string, err error) {
	clusterID = chi.URLParam(r, "id")
	if namespace, err = url.PathUnescape(chi.URLParam(r, "namespace")); err != nil {
		return
	}
	jobID, err = url.PathUnescape(chi.URLParam(r, "job_id"))
	return
}

func (a *API) caller(r *http.Request) jobs.Caller {
	p := principalFrom(r.Context())
	return jobs.Caller{Actor: a.actor(r), SessionID: p.Session.ID, IsAdmin: p.IsAdmin()}
}

func (a *API) withJob(w http.ResponseWriter, r *http.Request) (string, string, string, bool) {
	c, ns, id, err := jobRef(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_argument", "Job 路径编码不正确")
		return "", "", "", false
	}
	return c, ns, id, true
}

func (a *API) listJobs(w http.ResponseWriter, r *http.Request) {
	qv := r.URL.Query()
	out, err := a.Jobs.List(r.Context(), chi.URLParam(r, "id"), jobs.ListFilter{Namespace: qv.Get("namespace"), Type: qv.Get("type"),
		Status: qv.Get("status"), NodePool: qv.Get("node_pool"), Prefix: qv.Get("prefix")})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": out})
}

func (a *API) getJob(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	d, err := a.Jobs.Get(r.Context(), c, ns, id, principalFrom(r.Context()).IsAdmin())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": d})
}

func (a *API) jobVersions(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	v, err := a.Jobs.Versions(r.Context(), c, ns, id, principalFrom(r.Context()).IsAdmin())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *API) jobRevisions(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	_ = a.Jobs.Reconcile(r.Context(), c, ns, id)
	revs, err := a.Jobs.Revisions(r.Context(), c, ns, id)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revisions": revs})
}

func (a *API) jobDefinition(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	var version *uint64
	if v := r.URL.Query().Get("version"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", "version 不合法")
			return
		}
		version = &n
	}
	d, err := a.Jobs.DefinitionOf(r.Context(), c, ns, id, version)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"definition": d})
}

func (a *API) jobEditSource(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	es, err := a.Jobs.EditSourceOf(r.Context(), a.actor(r), c, ns, id)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"source": es})
}

func (a *API) revisionVariables(w http.ResponseWriter, r *http.Request) {
	vars, err := a.Jobs.RevisionVariables(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "revision_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"variables": vars})
}

func (a *API) reviewRevision(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Applied bool    `json:"applied"`
		Version *uint64 `json:"version"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := a.Jobs.ResolveReview(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "revision_id"), in.Applied, in.Version); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) jobAction(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	ctx, actor := r.Context(), a.actor(r)
	switch chi.URLParam(r, "action") {
	case "start":
		var in struct {
			IgnorePreflight bool `json:"ignore_preflight"`
		}
		if r.ContentLength != 0 {
			if !decodeJSON(w, r, &in) {
				return
			}
		}
		res, err := a.Jobs.StartWithOptions(ctx, actor, c, ns, id, in.IgnorePreflight)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": res})
	case "stop":
		if !decodeJSON(w, r, &struct{}{}) {
			return
		}
		eval, err := a.Jobs.Stop(ctx, actor, c, ns, id)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"eval_id": eval})
	case "purge":
		var in struct {
			ConfirmJobID string `json:"confirm_job_id"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		if err := a.Jobs.Purge(ctx, actor, c, ns, id, in.ConfirmJobID); err != nil {
			a.writeErr(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "revert":
		var in struct {
			Version uint64 `json:"version"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := a.Jobs.Revert(ctx, actor, c, ns, id, in.Version)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": res})
	case "restart":
		var in jobs.RestartInput
		if !decodeJSON(w, r, &in) {
			return
		}
		t, err := a.Jobs.Restart(ctx, actor, c, ns, id, in)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		taskResponse(w, t)
	case "scale":
		var in jobs.ScaleInput
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := a.Jobs.Scale(ctx, actor, c, ns, id, in)
		if err != nil {
			if res != nil {
				writeJSON(w, http.StatusAccepted, map[string]any{"result": res, "warning": err.Error()})
				return
			}
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": res})
	default:
		writeError(w, http.StatusNotFound, "not_found", "不支持的操作")
	}
}

func (a *API) jobOp(w http.ResponseWriter, r *http.Request) {
	clusterID := chi.URLParam(r, "id")
	ctx := r.Context()
	switch chi.URLParam(r, "op") {
	case "validate":
		var in jobs.PlanInput
		if !decodeJSON(w, r, &in) {
			return
		}
		j, warns, err := a.Jobs.ValidateInput(ctx, clusterID, in)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		warns = appendLintWarnings(warns, a.Jobs.InspectJobWarnings(ctx, clusterID, j))
		preflightErrs, preflightChecks := a.Jobs.PreflightJobDetailed(ctx, clusterID, j)
		writeJSON(w, http.StatusOK, map[string]any{
			"job":              j,
			"warnings":         warns,
			"preflight_errors": preflightErrs,
			"preflight_checks": preflightChecks,
		})
	case "plan":
		var in jobs.PlanInput
		if !decodeJSON(w, r, &in) {
			return
		}
		p, err := a.Jobs.Plan(ctx, a.caller(r), clusterID, in)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"plan": p})
	case "apply":
		var in struct {
			PlanID          string `json:"plan_id"`
			IgnorePreflight bool   `json:"ignore_preflight"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := a.Jobs.ApplyWithOptions(ctx, a.caller(r), clusterID, in.PlanID, in.IgnorePreflight)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": res})
	case "export":
		var in jobs.ExportInput
		if !decodeJSON(w, r, &in) {
			return
		}
		dw := &deferredDownloadWriter{w: w, contentType: "application/zip", filename: "nomad-jobs.zip"}
		if err := a.Jobs.Export(ctx, a.actor(r), clusterID, in, dw); err != nil {
			if !dw.wrote {
				a.writeErr(w, r, err)
				return
			}
			a.Log.Error("job export", "err", err)
		}
	case "hcl-tree":
		var in struct {
			HCL string `json:"hcl"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		doc, err := jobs.ParseHCLTree(in.HCL)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"document": doc, "schema": jobspec.BuilderSchema})
	case "hcl-tree-render":
		var in jobspec.HCLDocument
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := jobs.RenderHCLTree(&in)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	case "render":
		var in jobspec.JobSpec
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := jobs.RenderSpec(&in)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	case "parse-to-visual":
		var in struct {
			HCL       string            `json:"hcl"`
			Variables map[string]string `json:"variables"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := a.Jobs.ParseToVisual(ctx, clusterID, in.HCL, in.Variables)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	case "json-to-visual":
		var in struct {
			JobJSON    json.RawMessage `json:"job_json"`
			RevisionID string          `json:"revision_id"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		res, err := a.Jobs.JSONToVisual(ctx, clusterID, in.JobJSON, in.RevisionID)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	case "compose-convert":
		var in struct {
			Compose string `json:"compose"`
			jobspec.ComposeOptions
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		if len(in.Compose) > 1<<20 {
			writeError(w, http.StatusBadRequest, "invalid_argument", "Compose 文件过大")
			return
		}
		res, err := jobspec.ConvertCompose([]byte(in.Compose), in.ComposeOptions)
		if err != nil {
			writeError(w, http.StatusBadRequest, "compose_invalid", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)
	default:
		writeError(w, http.StatusNotFound, "not_found", "不支持的操作")
	}
}

func appendLintWarnings(existing string, extra []string) string {
	if len(extra) == 0 {
		return existing
	}
	joined := strings.Join(extra, "\n")
	if strings.TrimSpace(existing) == "" {
		return joined
	}
	return existing + "\n" + joined
}

// NewVaultInspector builds a callback used by jobs.Service to inspect live
// Nomad-Vault integrations, Vault KV v2 mounts, and KV secret keys.
func NewVaultInspector(d *db.DB, ints *integration.Service, vlt *vault.Service) func(ctx context.Context, clusterID string) ([]jobs.VaultIntegrationRef, jobs.KVSecretChecker) {
	return func(ctx context.Context, clusterID string) ([]jobs.VaultIntegrationRef, jobs.KVSecretChecker) {
		if ints == nil {
			return nil, nil
		}
		is, err := ints.List(ctx)
		if err != nil {
			return nil, nil
		}
		clients := map[string]*vault.Client{}
		clientFor := func(vaultID string) *vault.Client {
			if c, ok := clients[vaultID]; ok {
				return c
			}
			if vlt == nil || vaultID == "" {
				clients[vaultID] = nil
				return nil
			}
			c, err := vlt.AdminClient(ctx, vaultID)
			if err != nil {
				clients[vaultID] = nil
				return nil
			}
			clients[vaultID] = c
			return c
		}
		var refs []jobs.VaultIntegrationRef
		for _, i := range is {
			if i.SourceClusterID != clusterID {
				continue
			}
			ref := jobs.VaultIntegrationRef{
				ID:                i.ID,
				Name:              i.Name,
				Status:            i.Status,
				NomadSideEnabled:  i.NomadSideEnabled,
				TargetClusterID:   i.TargetClusterID,
				TargetClusterName: i.TargetCluster,
				ConfigDrifted:     i.ConfigDrifted,
				DriftReasons:      i.DriftReasons,
			}
			if d != nil {
				if dst, err := db.GetCluster(ctx, d.Reader, i.TargetClusterID); err == nil && dst != nil {
					ref.VaultTLSEnabled = dst.TLSEnabled
				}
			}
			if vc := clientFor(i.TargetClusterID); vc != nil {
				if mounts, err := vc.ListMounts(ctx); err == nil {
					ref.KVMountsQueried = true
					for p, m := range mounts {
						if m.Type == "kv" && m.Options["version"] == "2" {
							ref.KVMounts = append(ref.KVMounts, strings.Trim(p, "/"))
						}
					}
				}
			}
			for _, ro := range i.Roles {
				ref.Roles = append(ref.Roles, jobs.VaultRoleRef{
					ID:              ro.ID,
					RoleName:        ro.RoleName,
					PolicyName:      ro.PolicyName,
					Status:          ro.Status,
					BoundNamespace:  ro.BoundClaims["nomad_namespace"],
					PolicyMode:      ro.PolicyMode,
					SecretPaths:     ro.SecretPaths,
					CustomPolicyHCL: ro.CustomPolicy,
					TokenPeriod:     ro.TokenPeriod,
				})
			}
			refs = append(refs, ref)
		}
		checker := func(vaultClusterID, mount, path string) (map[string]bool, bool, error) {
			vc := clientFor(vaultClusterID)
			if vc == nil {
				return nil, false, fmt.Errorf("vault client unavailable")
			}
			sec, err := vc.KVRead(ctx, mount, path, true, 0)
			if err != nil {
				if vault.StatusOf(err) == http.StatusNotFound {
					return nil, false, nil
				}
				return nil, false, err
			}
			keys := map[string]bool{}
			if sec != nil {
				for k := range sec.Data {
					keys[k] = true
				}
			}
			return keys, true, nil
		}
		return refs, checker
	}
}

func (a *API) builderOptions(w http.ResponseWriter, r *http.Request) {
	clusterID := chi.URLParam(r, "id")
	o, err := a.Jobs.Options(r.Context(), clusterID)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	// Vault roles and integration summary fed by this cluster.
	roles := []map[string]any{}
	integrations := []map[string]any{}
	kvMountsSet := map[string]bool{}
	if a.Integrations != nil {
		if is, err := a.Integrations.List(r.Context()); err == nil {
			for _, i := range is {
				if i.SourceClusterID != clusterID {
					continue
				}
				var mounts []string
				if a.Vault != nil {
					if vc, err := a.Vault.AdminClient(r.Context(), i.TargetClusterID); err == nil {
						if ms, err := vc.ListMounts(r.Context()); err == nil {
							for p, m := range ms {
								if m.Type == "kv" && m.Options["version"] == "2" {
									clean := strings.Trim(p, "/")
									mounts = append(mounts, clean)
									kvMountsSet[clean] = true
								}
							}
						}
					}
				}
				integrations = append(integrations, map[string]any{
					"id":                 i.ID,
					"name":               i.Name,
					"status":             i.Status,
					"nomad_side_enabled": i.NomadSideEnabled,
					"vault_cluster_id":   i.TargetClusterID,
					"vault_cluster":      i.TargetCluster,
					"kv_mounts":          mounts,
				})
				for _, ro := range i.Roles {
					roles = append(roles, map[string]any{
						"role":               ro.RoleName,
						"namespace":          ro.BoundClaims["nomad_namespace"],
						"status":             ro.Status,
						"integration":        i.Name,
						"integration_id":     i.ID,
						"integration_status": i.Status,
						"policy_mode":        ro.PolicyMode,
						"secret_paths":       ro.SecretPaths,
						"vault_cluster_id":   i.TargetClusterID,
						"vault_cluster":      i.TargetCluster,
					})
				}
			}
		}
	}
	kvMounts := make([]string, 0, len(kvMountsSet))
	for m := range kvMountsSet {
		kvMounts = append(kvMounts, m)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"options":            o,
		"vault_roles":        roles,
		"vault_integrations": integrations,
		"vault_kv_mounts":    kvMounts,
	})
}

func (a *API) listTemplates(w http.ResponseWriter, r *http.Request) {
	out, err := a.Jobs.ListTemplates(r.Context(), r.URL.Query().Get("cluster_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": out})
}

func (a *API) getTemplate(w http.ResponseWriter, r *http.Request) {
	t, err := a.Jobs.GetTemplate(r.Context(), chi.URLParam(r, "tid"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"template": t})
}

func (a *API) putTemplate(w http.ResponseWriter, r *http.Request) {
	var in jobs.TemplateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	t, err := a.Jobs.PutTemplate(r.Context(), a.actor(r), chi.URLParam(r, "tid"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"template": t})
}

func (a *API) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	if err := a.Jobs.DeleteTemplate(r.Context(), a.actor(r), chi.URLParam(r, "tid")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
