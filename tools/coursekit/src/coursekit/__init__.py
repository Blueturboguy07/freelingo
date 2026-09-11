"""Freelingo content pipeline.

Stages G0-G9 and validators V1-V12 live here. Nothing in this package ships to the
app: it produces a signed content pack (read-only SQLite + content-addressed Opus
audio + a manifest carrying the validator report, defect rate and licences).
"""

__version__ = "0.1.0"
