package workbench

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMergeAllocationResources(t *testing.T) {
	var allocs []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`[
		{"ID":"current","ClientStatus":"running","TaskStates":{"web":{"State":"running"}}},
		{"ID":"collected","ClientStatus":"complete"}
	]`), &allocs); err != nil {
		t.Fatal(err)
	}
	raw, err := mergeAllocationResources(allocs, json.RawMessage(`[
		{"ID":"old-job","AllocatedResources":{"Shared":{"Ports":[{"Value":9999}]}}},
		{"ID":"current","ClientStatus":"failed","Job":{"Env":{"SECRET":"hidden-password"}},
		 "AllocatedResources":{"Shared":{"Ports":[{"Label":"http","HostIP":"10.2.156.158","Value":23885,"To":80}]}}}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	var result []struct {
		ID                 string
		ClientStatus       string
		TaskStates         json.RawMessage
		AllocatedResources struct {
			Shared struct {
				Ports []struct{ Value, To int }
			}
		}
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 || result[0].ID != "current" || result[1].ID != "collected" {
		t.Fatalf("allocation membership/order changed: %s", raw)
	}
	if result[0].ClientStatus != "running" || !strings.Contains(string(result[0].TaskStates), "web") {
		t.Fatalf("original runtime state changed: %s", raw)
	}
	ports := result[0].AllocatedResources.Shared.Ports
	if len(ports) != 1 || ports[0].Value != 23885 || ports[0].To != 80 {
		t.Fatalf("allocated ports missing: %s", raw)
	}
	if strings.Contains(string(raw), "hidden-password") || strings.Contains(string(raw), `"Job"`) {
		t.Fatalf("job definition leaked: %s", raw)
	}
}

func TestMergeAllocationResourcesRejectsInvalidData(t *testing.T) {
	if _, err := mergeAllocationResources(nil, json.RawMessage(`{}`)); err == nil {
		t.Fatal("invalid resource list accepted")
	}
	if _, err := mergeAllocationResources([]map[string]json.RawMessage{{"ID": json.RawMessage(`42`)}}, json.RawMessage(`[]`)); err == nil {
		t.Fatal("invalid allocation ID accepted")
	}
}
