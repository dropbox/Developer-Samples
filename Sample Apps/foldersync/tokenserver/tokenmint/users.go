package tokenmint

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"errors"
)

// DefaultUsersPath returns ~/.foldersync/tokenserver/users.json, or the same
// path under FOLDERSYNC_HOME if it's set.
func DefaultUsersPath(getenv func(string) string) (string, error) {
	home := getenv("FOLDERSYNC_HOME")
	if home == "" {
		dir, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("find the home folder: %w", err)
		}
		home = filepath.Join(dir, ".foldersync")
	}
	return filepath.Join(home, "tokenserver", "users.json"), nil
}

// maxNameLength bounds user names.
const maxNameLength = 64

// maxAgentIDLength bounds agent IDs.
const maxAgentIDLength = 256

// ValidateProject checks a project folder: a top-level Dropbox folder path
// like /storyboard, with no control characters.
func ValidateProject(project string) error {
	name, ok := strings.CutPrefix(project, "/")
	if !ok || name == "" || name == "." || name == ".." || strings.Contains(name, "/") ||
		utf8.RuneCountInString(name) > 255 {
		return fmt.Errorf("a project must be a top-level folder like /storyboard")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return errors.New("a project name can't contain control characters")
		}
	}
	return nil
}

// ValidateAgentID checks an agent ID: 1 to 256 printable characters.
func ValidateAgentID(agentID string) error {
	if agentID == "" || len(agentID) > maxAgentIDLength {
		return fmt.Errorf("an agent ID must be 1 to %d characters", maxAgentIDLength)
	}
	for _, r := range agentID {
		if !unicode.IsPrint(r) || unicode.IsSpace(r) {
			return errors.New("an agent ID can't contain spaces or control characters")
		}
	}
	return nil
}

// ValidateName checks a user name: 1 to 64 letters, digits, spaces, dots,
// dashes, or underscores, with no space at either end.
func ValidateName(name string) error {
	if name == "" || utf8.RuneCountInString(name) > maxNameLength {
		return fmt.Errorf("a name must be 1 to %d characters", maxNameLength)
	}
	if name[0] == ' ' || name[len(name)-1] == ' ' {
		return errors.New("a name can't start or end with a space")
	}
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != ' ' && r != '.' && r != '-' && r != '_' {
			return fmt.Errorf("a name can't contain %q", r)
		}
	}
	return nil
}

// UsersFile is the token server's list of managed users, users.json:
//
//	{
//	  "users": [
//	    {
//	      "name": "demo",
//	      "user_public_id": "pid_user:...",
//	      "connection_key": "<64 hex characters>",
//	      "created_at": "2026-10-20T22:00:00Z",
//	      "agents": {"/storyboard": "<agent ID>"}
//	    }
//	  ]
//	}
//
// user_public_id names the managed user in API calls; it isn't secret. The
// connection_key is the secret the app sends to get that user's tokens, so the file
// is written with mode 0600. agents records each project's agent, keyed by
// the project folder's path in lowercase.
type UsersFile struct {
	Users []User `json:"users"`
}

// User is one managed user the token server mints tokens for.
type User struct {
	// Name is a label for people, such as the person or device using it.
	Name string `json:"name"`
	// UserPublicID is the managed user's ID, from users/create.
	UserPublicID string `json:"user_public_id"`
	// ConnectionKey is the secret the app presents to POST /token.
	ConnectionKey string    `json:"connection_key"`
	CreatedAt     time.Time `json:"created_at"`
	// Agents maps each project folder, in lowercase, to its agent's ID.
	Agents map[string]string `json:"agents,omitempty"`
}

// LoadUsers reads a users file. A missing file is an empty list.
func LoadUsers(ctx context.Context, path string) (*UsersFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("read users file: %w", err)
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return &UsersFile{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read users file: %w", err)
	}
	var f UsersFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse users file: %w", err)
	}
	if err := f.validate(); err != nil {
		return nil, fmt.Errorf("users file %s: %w", path, err)
	}
	return &f, nil
}

// connectionKeyBytes is the length of a connection key before hex encoding.
const connectionKeyBytes = 32

// validate checks each entry, and that no two entries share a name, user
// public ID, or connection key, since lookups return the first match.
func (f *UsersFile) validate() error {
	names := map[string]bool{}
	ids := map[string]bool{}
	keys := map[string]bool{}
	for _, u := range f.Users {
		if err := ValidateName(u.Name); err != nil {
			return fmt.Errorf("entry %q: %w", u.Name, err)
		}
		if u.UserPublicID == "" {
			return fmt.Errorf("entry %q has no user_public_id", u.Name)
		}
		if key, err := hex.DecodeString(u.ConnectionKey); err != nil || len(key) != connectionKeyBytes {
			return fmt.Errorf("entry %q has an invalid connection_key", u.Name)
		}
		if u.CreatedAt.IsZero() {
			return fmt.Errorf("entry %q has no created_at", u.Name)
		}
		for project, agentID := range u.Agents {
			if err := ValidateProject(project); err != nil || project != strings.ToLower(project) {
				return fmt.Errorf("entry %q has an invalid project %q", u.Name, project)
			}
			if err := ValidateAgentID(agentID); err != nil {
				return fmt.Errorf("entry %q has an invalid agent ID for %q", u.Name, project)
			}
		}
		if names[u.Name] || ids[u.UserPublicID] || keys[u.ConnectionKey] {
			return fmt.Errorf("entry %q repeats a name, user_public_id, or connection_key", u.Name)
		}
		names[u.Name], ids[u.UserPublicID], keys[u.ConnectionKey] = true, true, true
	}
	return nil
}

// Find returns the user with this name.
func (f *UsersFile) Find(name string) (User, bool) {
	for _, u := range f.Users {
		if u.Name == name {
			return u, true
		}
	}
	return User{}, false
}

// FindByKey returns the user with this connection key.
func (f *UsersFile) FindByKey(key string) (User, bool) {
	if key == "" {
		return User{}, false
	}
	for _, u := range f.Users {
		if subtle.ConstantTimeCompare([]byte(u.ConnectionKey), []byte(key)) == 1 {
			return u, true
		}
	}
	return User{}, false
}

// RemoveByKey deletes the user with this connection key and returns it. Going
// by key, not name, never removes a newer user that took the same name.
func (f *UsersFile) RemoveByKey(key string) (User, bool) {
	if key == "" {
		return User{}, false
	}
	for i, u := range f.Users {
		if subtle.ConstantTimeCompare([]byte(u.ConnectionKey), []byte(key)) == 1 {
			f.Users = append(f.Users[:i], f.Users[i+1:]...)
			return u, true
		}
	}
	return User{}, false
}

// HasUserPublicID reports whether a user with this user public ID is in the file.
func (f *UsersFile) HasUserPublicID(userPublicID string) bool {
	for _, u := range f.Users {
		if u.UserPublicID == userPublicID {
			return true
		}
	}
	return false
}

// ClaimAgent records agentID as the project's agent for the user with this
// connection key, unless the project already has one. It returns the recorded
// agent ID, which is the earlier one if two computers claim the same project.
func (f *UsersFile) ClaimAgent(key, project, agentID string) (string, error) {
	for i, u := range f.Users {
		if subtle.ConstantTimeCompare([]byte(u.ConnectionKey), []byte(key)) != 1 {
			continue
		}
		if recorded, ok := u.Agents[project]; ok {
			return recorded, nil
		}
		if f.Users[i].Agents == nil {
			f.Users[i].Agents = map[string]string{}
		}
		f.Users[i].Agents[project] = agentID
		return agentID, nil
	}
	return "", errors.New("unknown connection key")
}

// Has reports whether a user with this name is already in the file.
func (f *UsersFile) Has(name string) bool {
	for _, u := range f.Users {
		if u.Name == name {
			return true
		}
	}
	return false
}

// Add appends a user with a new random connection key and returns it. Names
// must be unique, because sign-in finds the user by name.
func (f *UsersFile) Add(name, userPublicID string, now time.Time) (User, error) {
	if f.Has(name) {
		return User{}, fmt.Errorf("a user named %q already exists", name)
	}
	key := make([]byte, connectionKeyBytes)
	if _, err := rand.Read(key); err != nil {
		return User{}, fmt.Errorf("generate connection key: %w", err)
	}
	u := User{Name: name, UserPublicID: userPublicID, ConnectionKey: hex.EncodeToString(key), CreatedAt: now.UTC()}
	f.Users = append(f.Users, u)
	return u, nil
}

// UpdateUsers loads the users file, calls update, and saves the result if
// update returns nil. It holds a lock file for the whole time, so the server
// and the CLI don't overwrite each other's changes.
func UpdateUsers(ctx context.Context, path string, update func(*UsersFile) error) (err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create the users folder: %w", err)
	}
	unlock, err := lockFile(ctx, path+".lock")
	if err != nil {
		return fmt.Errorf("lock the users file: %w", err)
	}
	defer func() {
		if unlockErr := unlock(); unlockErr != nil {
			err = errors.Join(err, fmt.Errorf("unlock the users file: %w", unlockErr))
		}
	}()
	users, err := LoadUsers(ctx, path)
	if err != nil {
		return err
	}
	if err := update(users); err != nil {
		return err
	}
	// Never write a file that LoadUsers would reject.
	if err := users.validate(); err != nil {
		return fmt.Errorf("updated users file: %w", err)
	}
	data, err := json.MarshalIndent(users, "", "  ")
	if err != nil {
		return fmt.Errorf("encode users file: %w", err)
	}
	return writeUsersFile(ctx, path, append(data, '\n'))
}

// writeUsersFile saves the users file. Tests replace it to make saving fail.
var writeUsersFile = writeFileAtomic

// writeFileAtomic replaces path with data, mode 0600, through a temporary
// file in the same folder, so readers never see a partial file.
func writeFileAtomic(ctx context.Context, path string, data []byte) (err error) {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("write users file: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	closed, renamed := false, false
	defer func() {
		if !closed {
			if closeErr := tmp.Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close temp file: %w", closeErr))
			}
		}
		if !renamed {
			// The temp file can hold connection keys, so a failed write must not leave it.
			if removeErr := os.Remove(tmp.Name()); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				err = errors.Join(err, fmt.Errorf("remove temp file: %w", removeErr))
			}
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("set file mode: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	closed = true
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close file: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("replace file: %w", err)
	}
	renamed = true
	return nil
}
