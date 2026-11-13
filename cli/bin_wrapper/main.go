package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func findEngineRoot(start string) (string, bool) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", false
	}
	for {
		if fileExists(filepath.Join(dir, "cli", "illuci.mjs")) && fileExists(filepath.Join(dir, "package.json")) {
			return dir, true
		}
		next := filepath.Dir(dir)
		if next == dir {
			return "", false
		}
		dir = next
	}
}

func resolveEngineRoot() (string, error) {
	candidates := []string{}
	if env := os.Getenv("ILLUCI_ENGINE_HOME"); env != "" {
		candidates = append(candidates, env)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			candidates = append(candidates, filepath.Dir(resolved))
		} else {
			candidates = append(candidates, filepath.Dir(exe))
		}
	}

	for _, candidate := range candidates {
		if root, ok := findEngineRoot(candidate); ok {
			return root, nil
		}
	}
	return "", errors.New("could not locate illuci engine root; set ILLUCI_ENGINE_HOME to the checkout containing cli/illuci.mjs")
}

func main() {
	engineRoot, err := resolveEngineRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error resolving illuci engine: %v\n", err)
		os.Exit(1)
	}
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error resolving working directory: %v\n", err)
		os.Exit(1)
	}

	shimPath := filepath.Join(engineRoot, "cli", "illuci.mjs")
	nodeArgs := append([]string{shimPath}, os.Args[1:]...)

	cmd := exec.Command("node", nodeArgs...)
	cmd.Dir = cwd
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	err = cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "Error running illuci: %v\n", err)
		os.Exit(1)
	}
}
