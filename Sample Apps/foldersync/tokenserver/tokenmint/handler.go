package tokenmint

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"errors"
)

// Dropbox is the managed-user API the handler calls with the app's credentials.
type Dropbox interface {
	Mint(ctx context.Context, userPublicID string) (Token, error)
	CreateUser(ctx context.Context, name string) (string, error)
	DeleteUser(ctx context.Context, userPublicID string) error
}

var (
	_ Dropbox      = (*AppClient)(nil)
	_ http.Handler = (*Handler)(nil)
)

// maxBodyBytes bounds request bodies.
const maxBodyBytes = 64 << 10

const (
	// CreateTimeout bounds creating a managed user and saving it. It isn't cut
	// short when the client disconnects, so a created user is always saved or
	// rolled back.
	CreateTimeout = 30 * time.Second
	// CleanupTimeout bounds each step that must finish even if the request is
	// canceled: deleting a managed user that login created but couldn't save,
	// deleting a user for /delete-account, and removing its record.
	CleanupTimeout = 30 * time.Second
	// MutationTimeout is the longest a login or account deletion can take once
	// it starts changing anything.
	MutationTimeout = CreateTimeout + CleanupTimeout
)

// Handler serves the token server's routes:
//
//	GET  /health          the server is up, and which app it serves
//	POST /login           {"name": ...}: finds or creates the managed user and returns its connection key
//	POST /token           Bearer <connection key>: mints a token for that key's user
//	POST /delete-account  Bearer <connection key>: deletes that key's managed user from Dropbox
//	POST /project-agent   Bearer <connection key>, {"project": ..., "agent_id": ...}: returns the
//	                      project's recorded agent, recording agent_id if it has none
//
// Sign-in is by name only, which is fine for a demo on one computer: anyone
// who can reach the server and knows a name can get that user's tokens.
type Handler struct {
	Dropbox   Dropbox
	UsersPath string
	// AppKey is shown by /health so the app can say which Dropbox app it uses.
	AppKey string
	Now    func() time.Time

	// gate lets one login or account deletion run at a time. Waiting for it
	// stops when the request is canceled.
	gate     chan struct{}
	gateOnce sync.Once
}

// acquire waits for the gate, or for ctx to be done, and returns the function
// that releases the gate.
func (h *Handler) acquire(ctx context.Context) (func(), error) {
	h.gateOnce.Do(func() { h.gate = make(chan struct{}, 1) })
	select {
	case h.gate <- struct{}{}:
		// Don't start a mutation for a request that was canceled while it waited.
		if err := ctx.Err(); err != nil {
			<-h.gate
			return nil, fmt.Errorf("wait for another sign-in: %w", err)
		}
		return func() { <-h.gate }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("wait for another sign-in: %w", ctx.Err())
	}
}

type errorBody struct {
	Error string `json:"error"`
}

type loginArg struct {
	Name string `json:"name"`
}

// LoginResult is the response to POST /login.
type LoginResult struct {
	Name          string `json:"name"`
	UserPublicID  string `json:"user_public_id"`
	ConnectionKey string `json:"connection_key"`
	// Created is true when this login created a new managed user.
	Created bool `json:"created"`
}

type healthResult struct {
	Status string `json:"status"`
	AppKey string `json:"app_key"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/health":
		if requireMethod(w, r, http.MethodGet) {
			writeJSON(w, http.StatusOK, healthResult{Status: "ok", AppKey: h.AppKey})
		}
	case "/login":
		if requireMethod(w, r, http.MethodPost) {
			h.login(w, r)
		}
	case "/token":
		if requireMethod(w, r, http.MethodPost) {
			h.token(w, r)
		}
	case "/delete-account":
		if requireMethod(w, r, http.MethodPost) {
			h.deleteAccount(w, r)
		}
	case "/project-agent":
		if requireMethod(w, r, http.MethodPost) {
			h.projectAgent(w, r)
		}
	default:
		writeJSON(w, http.StatusNotFound, errorBody{Error: "not found"})
	}
}

// decodeJSON reads exactly one JSON object with only known fields from a body
// of at most maxBodyBytes.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("decode request body: %w", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("the request body has more than one JSON value")
	}
	return nil
}

// login signs in by name only, which is fine for a demo on one computer:
// anyone who can reach this server and knows a name gets that user's
// connection key. Your backend must authenticate the caller here and check
// that it may act as the managed user before returning a key.
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var arg loginArg
	if err := decodeJSON(w, r, &arg); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "send {\"name\": ...}"})
		return
	}
	name := strings.TrimSpace(arg.Name)
	if err := ValidateName(name); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	release, err := h.acquire(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "request canceled"})
		return
	}
	defer release()
	// Once a managed user is created it must be saved or rolled back, so the
	// client disconnecting doesn't cut this short.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), CreateTimeout)
	defer cancel()
	var res LoginResult
	var created string
	err = UpdateUsers(ctx, h.UsersPath, func(users *UsersFile) error {
		if u, ok := users.Find(name); ok {
			res = LoginResult{Name: u.Name, UserPublicID: u.UserPublicID, ConnectionKey: u.ConnectionKey}
			return nil
		}
		id, err := h.Dropbox.CreateUser(ctx, name)
		if err != nil {
			return err
		}
		log.Printf("created managed user %s for %q", id, name)
		// Rolling back would delete the account another user already has.
		if users.HasUserPublicID(id) {
			return fmt.Errorf("users/create returned %s, which another user already has", id)
		}
		created = id
		u, err := users.Add(name, id, h.Now())
		if err != nil {
			return err
		}
		res = LoginResult{Name: u.Name, UserPublicID: u.UserPublicID, ConnectionKey: u.ConnectionKey, Created: true}
		return nil
	})
	if err != nil {
		if created != "" {
			err = h.undoCreate(r.Context(), created, err)
		}
		writeDropboxError(w, "login", err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// undoCreate deletes a managed user that login created but couldn't save, so a
// retry doesn't leave it behind with nothing pointing at it. It returns cause,
// with any cleanup failure added.
func (h *Handler) undoCreate(ctx context.Context, userPublicID string, cause error) error {
	// The request may be canceled, so cleanup keeps its values but gets its own deadline.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), CleanupTimeout)
	defer cancel()
	users, err := LoadUsers(ctx, h.UsersPath)
	if err != nil {
		return errors.Join(cause, fmt.Errorf("managed user %s may not be saved; check the users file: %w", userPublicID, err))
	}
	if users.HasUserPublicID(userPublicID) {
		// Saved after all; only something after the save failed.
		return cause
	}
	if err := h.Dropbox.DeleteUser(ctx, userPublicID); err != nil {
		return errors.Join(cause, fmt.Errorf("delete unsaved managed user %s: %w", userPublicID, err))
	}
	log.Printf("deleted managed user %s, which couldn't be saved", userPublicID)
	return cause
}

// token mints a token for the connection key's managed user. Your backend
// must instead authenticate the caller and mint for the managed user mapped
// to that identity.
func (h *Handler) token(w http.ResponseWriter, r *http.Request) {
	user, ok := h.userFor(w, r)
	if !ok {
		return
	}
	tok, err := h.Dropbox.Mint(r.Context(), user.UserPublicID)
	if err != nil {
		writeDropboxError(w, "mint", err)
		return
	}
	writeJSON(w, http.StatusOK, tok)
}

func (h *Handler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	user, ok := h.userFor(w, r)
	if !ok {
		return
	}
	release, err := h.acquire(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "request canceled"})
		return
	}
	defer release()
	// Delete in Dropbox first, so a failure leaves the entry for a retry. Neither
	// step stops if the client disconnects, so a deleted user's record goes too.
	deleteCtx, cancelDelete := context.WithTimeout(context.WithoutCancel(r.Context()), CleanupTimeout)
	defer cancelDelete()
	if err := h.Dropbox.DeleteUser(deleteCtx, user.UserPublicID); err != nil {
		writeDropboxError(w, "delete user", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), CleanupTimeout)
	defer cancel()
	err = UpdateUsers(ctx, h.UsersPath, func(users *UsersFile) error {
		// By key: a newer user may have taken the name meanwhile.
		users.RemoveByKey(user.ConnectionKey)
		return nil
	})
	if err != nil {
		log.Printf("remove deleted user from the users file: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: "the account was deleted, but the users file couldn't be updated"})
		return
	}
	log.Printf("deleted managed user %s (%q)", user.UserPublicID, user.Name)
	writeJSON(w, http.StatusOK, map[string]string{"deleted": user.Name})
}

type projectAgentArg struct {
	Project string `json:"project"`
	// AgentID, if set, is recorded when the project has no agent yet.
	AgentID string `json:"agent_id,omitempty"`
}

// ProjectAgentResult is the response to POST /project-agent. AgentID is empty
// when the project has no agent and the request didn't give one.
type ProjectAgentResult struct {
	AgentID string `json:"agent_id"`
}

// projectAgent returns the agent recorded for one of the user's projects, so
// every computer uses the same agent and its history. With agent_id, it
// records that agent first if the project has none. Your backend must check
// that the caller may act as the managed user, as for token.
func (h *Handler) projectAgent(w http.ResponseWriter, r *http.Request) {
	user, ok := h.userFor(w, r)
	if !ok {
		return
	}
	var arg projectAgentArg
	if err := decodeJSON(w, r, &arg); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "send {\"project\": ..., \"agent_id\": ...}"})
		return
	}
	project := strings.ToLower(arg.Project)
	if err := ValidateProject(project); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	if arg.AgentID == "" {
		writeJSON(w, http.StatusOK, ProjectAgentResult{AgentID: user.Agents[project]})
		return
	}
	if err := ValidateAgentID(arg.AgentID); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	var recorded string
	err := UpdateUsers(r.Context(), h.UsersPath, func(users *UsersFile) error {
		var err error
		recorded, err = users.ClaimAgent(user.ConnectionKey, project, arg.AgentID)
		return err
	})
	if err != nil {
		log.Printf("record agent for %s: %v", project, err)
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: "can't record the project's agent"})
		return
	}
	writeJSON(w, http.StatusOK, ProjectAgentResult{AgentID: recorded})
}

// userFor returns the user for a "Bearer <connection key>" header, or writes
// an error and returns false.
func (h *Handler) userFor(w http.ResponseWriter, r *http.Request) (User, bool) {
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || key == "" {
		writeJSON(w, http.StatusUnauthorized, errorBody{Error: "unknown connection key"})
		return User{}, false
	}
	users, err := LoadUsers(r.Context(), h.UsersPath)
	if err != nil {
		log.Printf("load users: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: "can't read the users file"})
		return User{}, false
	}
	user, ok := users.FindByKey(key)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errorBody{Error: "unknown connection key"})
		return User{}, false
	}
	return user, true
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	writeJSON(w, http.StatusMethodNotAllowed, errorBody{Error: "use " + method})
	return false
}

// writeDropboxError passes Dropbox's error summary back and hides other
// errors, which can contain internal details.
func writeDropboxError(w http.ResponseWriter, action string, err error) {
	// Log the whole error first: it can include a failed cleanup.
	log.Printf("%s failed: %v", action, err)
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		writeJSON(w, http.StatusBadGateway, errorBody{Error: apiErr.Summary})
		return
	}
	writeJSON(w, http.StatusBadGateway, errorBody{Error: action + " failed"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}
