package jobs

import (
	"nomad-deck/internal/auth"
	"nomad-deck/internal/jobspec"
)

// ParseHCLTree preserves the complete source document for structural editing.
func ParseHCLTree(src string) (*jobspec.HCLDocument, error) {
	doc, err := jobspec.ParseDocument(src)
	if err != nil {
		return nil, &auth.Error{Status: 400, Code: "hcl_invalid", Message: err.Error()}
	}
	return doc, nil
}

// RenderHCLTree returns the current draft and its structural diagnostics.
func RenderHCLTree(doc *jobspec.HCLDocument) (*jobspec.DocumentResult, error) {
	res, err := jobspec.RenderDocument(doc)
	if err != nil {
		return nil, &auth.Error{Status: 400, Code: "hcl_tree_invalid", Message: err.Error()}
	}
	return res, nil
}
