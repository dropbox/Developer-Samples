// Package tokenmint creates managed users and mints their access tokens for
// the FolderSync sample app. It holds the app key and secret, so it must run
// server-side in a real product.
package tokenmint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"errors"
)

// DefaultEndpoint is the Dropbox API origin.
const DefaultEndpoint = "https://api.dropboxapi.com"

const (
	mintRoute       = "/2/agent_filesystem/users/access_token/mint"
	createUserRoute = "/2/agent_filesystem/users/create"
	deleteUserRoute = "/2/agent_filesystem/users/delete"
	checkAppRoute   = "/2/check/app"
)

// maxResponseBytes bounds how much of a response is read.
const maxResponseBytes = 1 << 20

// UserScopes are the scopes minted for a managed user: files/* routes, plus
// creating agents, minting their tokens, listing their writes, and undoing them.
var UserScopes = []string{
	"files.metadata.read",
	"files.metadata.write",
	"files.content.read",
	"files.content.write",
	"private:agent_filesystem.agents.manage",
	"private:agent_filesystem.agents.restore",
}

// Token is a minted access token and when it expires.
type Token struct {
	AccessToken string    `json:"access_token"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// APIError is an error response from Dropbox.
type APIError struct {
	// Status is the HTTP status Dropbox returned.
	Status int
	// Summary is Dropbox's error_summary, or the response body if there is none.
	Summary string
}

var _ error = (*APIError)(nil)

func (e *APIError) Error() string {
	return "Dropbox returned HTTP " + http.StatusText(e.Status) + ": " + e.Summary
}

// AppClient calls the managed-user routes with the app's credentials.
type AppClient struct {
	Client    *http.Client
	Endpoint  string
	AppKey    string
	AppSecret string
	Scopes    []string
	Now       func() time.Time
}

type userSelector struct {
	Tag          string `json:".tag"`
	UserPublicID string `json:"user_public_id"`
}

type mintArg struct {
	User   userSelector `json:"user"`
	Scopes []string     `json:"scopes"`
}

type mintResult struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

type createUserEntry struct {
	Name string `json:"name,omitempty"`
}

type createUsersArg struct {
	Entries []createUserEntry `json:"entries"`
}

type createUsersResult struct {
	Users []struct {
		PublicID string `json:"user_public_id"`
	} `json:"users"`
}

type deleteUsersArg struct {
	Users []userSelector `json:"users"`
}

type apiError struct {
	ErrorSummary string `json:"error_summary"`
}

// Mint returns a new access token for the managed user.
func (c *AppClient) Mint(ctx context.Context, userPublicID string) (Token, error) {
	if userPublicID == "" {
		return Token{}, errors.New("user public ID is empty")
	}
	var res mintResult
	err := c.call(ctx, mintRoute, mintArg{
		User:   userSelector{Tag: "user_public_id", UserPublicID: userPublicID},
		Scopes: c.Scopes,
	}, &res)
	if err != nil {
		return Token{}, fmt.Errorf("mint token: %w", err)
	}
	if res.AccessToken == "" || res.ExpiresIn <= 0 || res.ExpiresIn > maxExpiresIn {
		return Token{}, errors.New("mint response has no token or valid expiry")
	}
	return Token{
		AccessToken: res.AccessToken,
		ExpiresAt:   c.Now().Add(time.Duration(res.ExpiresIn) * time.Second).UTC(),
	}, nil
}

// maxExpiresIn is the longest expires_in, in seconds, that fits in a time.Duration.
const maxExpiresIn = int64(time.Duration(1<<63-1) / time.Second)

// CreateUser creates one managed user and returns its user public ID.
func (c *AppClient) CreateUser(ctx context.Context, name string) (string, error) {
	var res createUsersResult
	if err := c.call(ctx, createUserRoute, createUsersArg{Entries: []createUserEntry{{Name: name}}}, &res); err != nil {
		return "", fmt.Errorf("create user: %w", err)
	}
	if len(res.Users) != 1 || res.Users[0].PublicID == "" {
		return "", fmt.Errorf("users/create returned %d users for one request", len(res.Users))
	}
	return res.Users[0].PublicID, nil
}

type checkArg struct {
	Query string `json:"query"`
}

type checkResult struct {
	Result string `json:"result"`
}

// CheckCredentials confirms that Dropbox accepts the app key and secret.
func (c *AppClient) CheckCredentials(ctx context.Context) error {
	const query = "foldersync"
	var res checkResult
	if err := c.call(ctx, checkAppRoute, checkArg{Query: query}, &res); err != nil {
		return fmt.Errorf("check app credentials: %w", err)
	}
	if res.Result != query {
		return errors.New("check/app returned an unexpected result")
	}
	return nil
}

// DeleteUser deletes a managed user. Dropbox disables the account and
// schedules its files for deletion; this can't be undone.
func (c *AppClient) DeleteUser(ctx context.Context, userPublicID string) error {
	if userPublicID == "" {
		return errors.New("user public ID is empty")
	}
	arg := deleteUsersArg{Users: []userSelector{{Tag: "user_public_id", UserPublicID: userPublicID}}}
	if err := c.call(ctx, deleteUserRoute, arg, nil); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return nil
}

// call POSTs arg as JSON with HTTP Basic app auth and decodes the result into
// result, unless result is nil.
func (c *AppClient) call(ctx context.Context, route string, arg, result any) error {
	body, err := json.Marshal(arg)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.Endpoint, "/")+route, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.SetBasicAuth(c.AppKey, c.AppSecret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("call %s: %w", route, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return fmt.Errorf("%s response is larger than %d bytes", route, maxResponseBytes)
	}
	if resp.StatusCode != http.StatusOK {
		return &APIError{Status: resp.StatusCode, Summary: summaryOf(data)}
	}
	if result == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// summaryOf returns Dropbox's error_summary, or the trimmed body.
func summaryOf(data []byte) string {
	var e apiError
	if json.Unmarshal(data, &e) == nil && e.ErrorSummary != "" {
		return e.ErrorSummary
	}
	return strings.TrimSpace(string(data))
}
