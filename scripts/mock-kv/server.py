#!/usr/bin/env python3
"""
Mock Cloudflare KV API server for local development.
Simulates the KV namespace REST API on localhost:8080.
"""

import json
import os
from pathlib import Path
from flask import Flask, request, jsonify, abort

app = Flask(__name__)

# In-memory storage (persisted to disk for container restarts)
STORAGE_FILE = Path("/mock-kv/storage.json")
STORAGE_FILE.parent.mkdir(parents=True, exist_ok=True)

# Load existing storage
if STORAGE_FILE.exists():
    with open(STORAGE_FILE) as f:
        storage = json.load(f)
else:
    storage = {}

def save_storage():
    """Persist storage to disk."""
    with open(STORAGE_FILE, "w") as f:
        json.dump(storage, f, ensure_ascii=False, indent=2)

@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "keys": len(storage)})

# Cloudflare KV REST API compatibility
# PUT /accounts/:account_id/storage/kv/namespaces/:namespace_id/values/:key
# GET  /accounts/:account_id/storage/kv/namespaces/:namespace_id/values/:key
# DELETE /accounts/:account_id/storage/kv/namespaces/:namespace_id/values/:key
# LIST /accounts/:account_id/storage/kv/namespaces/:namespace_id/keys

@app.route("/accounts/<account_id>/storage/kv/namespaces/<namespace_id>/values/<path:key>", methods=["PUT"])
def put_value(account_id, namespace_id, key):
    """Store a value in KV."""
    # Get expiration TTL from header (Cloudflare uses expiration-ttl header)
    expiration_ttl = request.headers.get("expiration-ttl")
    if expiration_ttl:
        expiration_ttl = int(expiration_ttl)
    
    # Read value from body
    value = request.get_data(as_text=True)
    
    storage[key] = {
        "value": value,
        "expiration_ttl": expiration_ttl,
        "metadata": request.headers.get("metadata", "{}")
    }
    save_storage()
    
    return jsonify({"success": True, "key": key})

@app.route("/accounts/<account_id>/storage/kv/namespaces/<namespace_id>/values/<path:key>", methods=["GET"])
def get_value(account_id, namespace_id, key):
    """Retrieve a value from KV."""
    if key not in storage:
        abort(404, description="Key not found")
    
    entry = storage[key]
    response = jsonify({"value": entry["value"]})
    response.headers["Content-Type"] = "application/json"
    return response

@app.route("/accounts/<account_id>/storage/kv/namespaces/<namespace_id>/values/<path:key>", methods=["DELETE"])
def delete_value(account_id, namespace_id, key):
    """Delete a value from KV."""
    if key in storage:
        del storage[key]
        save_storage()
    return jsonify({"success": True})

@app.route("/accounts/<account_id>/storage/kv/namespaces/<namespace_id>/keys", methods=["GET"])
def list_keys(account_id, namespace_id):
    """List keys in KV namespace."""
    prefix = request.args.get("prefix", "")
    limit = int(request.args.get("limit", "1000"))
    cursor = request.args.get("cursor", "")
    
    keys = [k for k in storage.keys() if k.startswith(prefix)]
    
    # Simple cursor pagination
    start = int(cursor) if cursor else 0
    end = min(start + limit, len(keys))
    result_keys = keys[start:end]
    next_cursor = str(end) if end < len(keys) else None
    
    result = {"keys": [{"name": k} for k in result_keys]}
    if next_cursor:
        result["cursor"] = next_cursor
    
    return jsonify(result)

# Convenience endpoints for local testing
@app.route("/local/keys", methods=["GET"])
def local_list_keys():
    """Simple local endpoint to list all keys."""
    return jsonify({"keys": list(storage.keys()), "count": len(storage)})

@app.route("/local/clear", methods=["POST"])
def local_clear():
    """Clear all storage (testing only)."""
    storage.clear()
    save_storage()
    return jsonify({"success": True, "message": "Storage cleared"})

@app.route("/local/dump", methods=["GET"])
def local_dump():
    """Dump entire storage (testing only)."""
    return jsonify(storage)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=True)