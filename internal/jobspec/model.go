// Package jobspec is the visual job builder model: a structured JobSpec
// rendered to HCL with hclwrite tokens, restricted per-level HCL fragments
// validated on the HCL syntax tree, mapping of HCL and Nomad Job JSON back
// into the model with a list of what cannot be kept, and Docker Compose
// conversion.
package jobspec

// RendererVersion identifies the renderer that produced an HCL document.
const RendererVersion = "1"

// Scalar fields are strings: empty means unset, "var.<name>" references a
// variable, anything else is a literal of the field's kind (string, number
// or bool).

// JobSpec is the visual model of a job file.
type JobSpec struct {
	Variables []Variable `json:"variables,omitempty"`
	Job       Job        `json:"job"`
}

// Variable is a top-level variable block.
type Variable struct {
	Name        string `json:"name"`
	Type        string `json:"type,omitempty"`
	Default     string `json:"default,omitempty"`
	HasDefault  bool   `json:"has_default,omitempty"`
	Description string `json:"description,omitempty"`
}

// KV is an ordered key/value pair.
type KV struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Constraint is a constraint block.
type Constraint struct {
	Attribute string `json:"attribute,omitempty"`
	Operator  string `json:"operator,omitempty"`
	Value     string `json:"value,omitempty"`
}

// Periodic is the periodic block.
type Periodic struct {
	Crons           []string `json:"crons"`
	ProhibitOverlap string   `json:"prohibit_overlap,omitempty"`
	TimeZone        string   `json:"time_zone,omitempty"`
	Enabled         string   `json:"enabled,omitempty"`
}

// Update is an update block (job or group level).
type Update struct {
	MaxParallel      string `json:"max_parallel,omitempty"`
	HealthCheck      string `json:"health_check,omitempty"`
	MinHealthyTime   string `json:"min_healthy_time,omitempty"`
	HealthyDeadline  string `json:"healthy_deadline,omitempty"`
	ProgressDeadline string `json:"progress_deadline,omitempty"`
	AutoRevert       string `json:"auto_revert,omitempty"`
	AutoPromote      string `json:"auto_promote,omitempty"`
	Canary           string `json:"canary,omitempty"`
	Stagger          string `json:"stagger,omitempty"`
}

// Job is the job block.
type Job struct {
	ID          string       `json:"id"`
	Namespace   string       `json:"namespace,omitempty"`
	Region      string       `json:"region,omitempty"`
	NodePool    string       `json:"node_pool,omitempty"`
	Type        string       `json:"type,omitempty"`
	Datacenters []string     `json:"datacenters,omitempty"`
	Priority    string       `json:"priority,omitempty"`
	Meta        []KV         `json:"meta,omitempty"`
	Constraints []Constraint `json:"constraints,omitempty"`
	Periodic    *Periodic    `json:"periodic,omitempty"`
	Update      *Update      `json:"update,omitempty"`
	Groups      []Group      `json:"groups"`
	Extra       string       `json:"extra_hcl,omitempty"`
}

// Port is a network port.
type Port struct {
	Label       string `json:"label"`
	To          string `json:"to,omitempty"`
	Static      string `json:"static,omitempty"`
	HostNetwork string `json:"host_network,omitempty"`
}

// Network is a group network block.
type Network struct {
	Mode  string `json:"mode,omitempty"`
	Ports []Port `json:"ports,omitempty"`
}

// Volume is a group volume request.
type Volume struct {
	Name           string `json:"name"`
	Type           string `json:"type,omitempty"` // host | csi
	Source         string `json:"source,omitempty"`
	ReadOnly       string `json:"read_only,omitempty"`
	AccessMode     string `json:"access_mode,omitempty"`
	AttachmentMode string `json:"attachment_mode,omitempty"`
	PerAlloc       string `json:"per_alloc,omitempty"`
}

// Check is a service check.
type Check struct {
	Name        string `json:"name,omitempty"`
	Type        string `json:"type,omitempty"`
	Path        string `json:"path,omitempty"`
	Port        string `json:"port,omitempty"`
	AddressMode string `json:"address_mode,omitempty"`
	Interval    string `json:"interval,omitempty"`
	Timeout     string `json:"timeout,omitempty"`
}

// Service is a service registration.
type Service struct {
	Name        string   `json:"name,omitempty"`
	Port        string   `json:"port,omitempty"`
	Provider    string   `json:"provider,omitempty"`
	AddressMode string   `json:"address_mode,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Checks      []Check  `json:"checks,omitempty"`
}

// Restart is a restart block.
type Restart struct {
	Attempts string `json:"attempts,omitempty"`
	Interval string `json:"interval,omitempty"`
	Delay    string `json:"delay,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

// Reschedule is a reschedule block.
type Reschedule struct {
	Attempts      string `json:"attempts,omitempty"`
	Interval      string `json:"interval,omitempty"`
	Delay         string `json:"delay,omitempty"`
	DelayFunction string `json:"delay_function,omitempty"`
	MaxDelay      string `json:"max_delay,omitempty"`
	Unlimited     string `json:"unlimited,omitempty"`
}

// EphemeralDisk is an ephemeral_disk block.
type EphemeralDisk struct {
	Size    string `json:"size,omitempty"`
	Migrate string `json:"migrate,omitempty"`
	Sticky  string `json:"sticky,omitempty"`
}

// Group is a task group.
type Group struct {
	Name          string         `json:"name"`
	Count         string         `json:"count,omitempty"`
	Constraints   []Constraint   `json:"constraints,omitempty"`
	Network       *Network       `json:"network,omitempty"`
	Volumes       []Volume       `json:"volumes,omitempty"`
	Services      []Service      `json:"services,omitempty"`
	Restart       *Restart       `json:"restart,omitempty"`
	Reschedule    *Reschedule    `json:"reschedule,omitempty"`
	Update        *Update        `json:"update,omitempty"`
	EphemeralDisk *EphemeralDisk `json:"ephemeral_disk,omitempty"`
	Meta          []KV           `json:"meta,omitempty"`
	Tasks         []Task         `json:"tasks"`
	Extra         string         `json:"extra_hcl,omitempty"`
}

// Lifecycle is a task lifecycle block.
type Lifecycle struct {
	Hook    string `json:"hook,omitempty"`
	Sidecar string `json:"sidecar,omitempty"`
}

// BindOptions are Docker bind mount options.
type BindOptions struct {
	Propagation string `json:"propagation,omitempty"`
}

// Mount is a structured Docker mount.
type Mount struct {
	Type        string       `json:"type,omitempty"`
	Source      string       `json:"source,omitempty"`
	Target      string       `json:"target,omitempty"`
	Readonly    string       `json:"readonly,omitempty"`
	BindOptions *BindOptions `json:"bind_options,omitempty"`
}

// Logging is the Docker logging block.
type Logging struct {
	Type   string `json:"type,omitempty"`
	Config []KV   `json:"config,omitempty"`
}

// Auth is the Docker registry auth block.
type Auth struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// Config is a task driver config (docker, exec, raw_exec).
type Config struct {
	Image       string   `json:"image,omitempty"`
	ForcePull   string   `json:"force_pull,omitempty"`
	Command     string   `json:"command,omitempty"`
	Args        []string `json:"args,omitempty"`
	Ports       []string `json:"ports,omitempty"`
	NetworkMode string   `json:"network_mode,omitempty"`
	Privileged  string   `json:"privileged,omitempty"`
	Auth        *Auth    `json:"auth,omitempty"`
	Volumes     []string `json:"volumes,omitempty"`
	Mounts      []Mount  `json:"mounts,omitempty"`
	Logging     *Logging `json:"logging,omitempty"`
}

// VolumeMount is a task volume_mount block.
type VolumeMount struct {
	Volume          string `json:"volume"`
	Destination     string `json:"destination"`
	ReadOnly        string `json:"read_only,omitempty"`
	PropagationMode string `json:"propagation_mode,omitempty"`
}

// Resources is a task resources block.
type Resources struct {
	CPU       string `json:"cpu,omitempty"`
	Memory    string `json:"memory,omitempty"`
	MemoryMax string `json:"memory_max,omitempty"`
}

// Logs is a task logs block.
type Logs struct {
	MaxFiles    string `json:"max_files,omitempty"`
	MaxFileSize string `json:"max_file_size,omitempty"`
}

// Vault is a task vault block.
type Vault struct {
	Role       string `json:"role,omitempty"`
	Cluster    string `json:"cluster,omitempty"`
	ChangeMode string `json:"change_mode,omitempty"`
	Env        string `json:"env,omitempty"`
}

// Identity is a task identity block.
type Identity struct {
	Name string   `json:"name,omitempty"`
	Aud  []string `json:"aud,omitempty"`
	File string   `json:"file,omitempty"`
	TTL  string   `json:"ttl,omitempty"`
}

// Template is a task template block.
type Template struct {
	Destination    string `json:"destination,omitempty"`
	Data           string `json:"data,omitempty"`
	Env            string `json:"env,omitempty"`
	Perms          string `json:"perms,omitempty"`
	ChangeMode     string `json:"change_mode,omitempty"`
	LeftDelimiter  string `json:"left_delimiter,omitempty"`
	RightDelimiter string `json:"right_delimiter,omitempty"`
	Splay          string `json:"splay,omitempty"`
}

// Task is a task.
type Task struct {
	Name         string        `json:"name"`
	Driver       string        `json:"driver"`
	Lifecycle    *Lifecycle    `json:"lifecycle,omitempty"`
	Config       Config        `json:"config"`
	Env          []KV          `json:"env,omitempty"`
	VolumeMounts []VolumeMount `json:"volume_mounts,omitempty"`
	Resources    *Resources    `json:"resources,omitempty"`
	Logs         *Logs         `json:"logs,omitempty"`
	Restart      *Restart      `json:"restart,omitempty"`
	Services     []Service     `json:"services,omitempty"`
	Vault        *Vault        `json:"vault,omitempty"`
	Identities   []Identity    `json:"identities,omitempty"`
	Templates    []Template    `json:"templates,omitempty"`
	Meta         []KV          `json:"meta,omitempty"`
	Extra        string        `json:"extra_hcl,omitempty"`
}
