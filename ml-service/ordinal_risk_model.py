"""Ordinal risk classifier for FreightSight.

ROLLING RECENCY CALIBRATION (2026-09, follow-up fix): calibrate_thresholds
(below) originally used the regressor's OOB predictions across the ENTIRE
training set to fix q1/q2 — every year of history weighted equally. That
static, whole-history calibration is the second half of the "risk always
comes back high" bug (the first half was risk_score's own components
clipping against a frozen train-only percentile reference — see train.py).
Even with risk_score itself made regime-adaptive, a threshold calibrated
once and never revisited still drifts stale over a long deployment. Passing
sample_months to fit() plus calibration_recency_months at construction
restricts calibration to the most recent N months of the training window
(falling back to the full OOB set if that recent slice has too few rows),
so thresholds track the current regime rather than an average over years of
history. This is additive: sample_months is optional and the class behaves
exactly as before when it isn't supplied.

WHY THIS FILE EXISTS (bug fix, 2026-09):

The risk model was a plain RandomForestClassifier trained directly on the
low/medium/high BUCKET labels (target_risk), which are themselves just a
continuous `risk_score` cut into tertiles. Measured result (see
AUDIT_REPORT.md / metadata.json before this fix): "medium" scored 0%
precision AND 0% recall in the primary holdout AND in every walk-forward CV
fold, across every historical window tested. That's not noise — it's
structural. A nominal multiclass classifier makes hard either/or splits; it
has no notion of "close to the boundary." "medium" is the one class bordered
on BOTH sides (by low and by high), so any prediction error near either
threshold gets thrown to a neighbor, and the middle class has no feature
signature of its own to fall back on.

FIX: regress the underlying continuous `risk_score` (RandomForestRegressor,
the same architecture already used for the rate forecast) and only bucket
the FINAL predicted score into low/medium/high, using the same train-only
q1/q2 thresholds the labels themselves were built from. A regressor that's
near a boundary degrades gracefully into the adjacent class instead of the
middle class collapsing outright.

This class exists so that swap is invisible to every downstream consumer
(app/utils.py ModelBundle): it exposes the same .predict() / .predict_proba()
/ .classes_ / .feature_importances_ surface a RandomForestClassifier would,
so nothing else in the codebase needs to change.

predict_proba is derived from the forest's own tree-level spread (each of
n_estimators trees gives its own continuous prediction for a row; bucket each
tree's prediction the same way as the final prediction; the fraction of trees
landing in each bucket is that class's probability). This is the same
non-parametric "spread across trees" technique train.py already uses
elsewhere for forecast uncertainty bounds — not a fabricated confidence
score.
"""
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.ensemble import RandomForestRegressor


class OrdinalRiskClassifier(BaseEstimator, ClassifierMixin):
    def __init__(self, thresholds, class_names=("low", "medium", "high"), calibrate_thresholds=True,
                 calibration_recency_months=None, **rf_kwargs):
        """thresholds: (q1, q2) — the train-only tertile cutpoints of the
        RAW risk_score, i.e. the same cutpoints used to build the
        low/medium/high ground-truth labels. Kept and reported as-is
        (metadata.json risk_thresholds), but NOT what this model buckets
        its own predictions against — see calibrate_thresholds below.

        calibrate_thresholds: (measured necessity, not a hypothetical) a
        RandomForestRegressor's predictions are compressed relative to the
        true target — its leaves average many training rows together, so
        the predicted range is narrower than the actual risk_score range,
        and that narrower band isn't necessarily centered on the raw
        tertile cutpoints. Empirically, bucketing this model's test-set
        predictions against the RAW thresholds pushed ~75% of test rows
        into "high" (median predicted score sat above q2 even though the
        true test median sat in the "medium" band) — trading the old
        "always low" collapse for an "always high" one, not fixing it.
        Fix: when True (default), refit thresholds against the
        REGRESSOR'S OWN out-of-bag predictions on the training set
        (leak-free — each row's OOB prediction only uses trees that didn't
        see it) instead of the raw label distribution. This recenters the
        low/medium/high split on what the model actually outputs, which is
        what matters for a 3-way bucket decision.

        calibration_recency_months: optional. When set (and sample_months
        is passed to fit()), the OOB quantile calibration above uses only
        rows whose month falls within the trailing N months of the
        training window, instead of averaging over the whole training
        history. A single calibration fit years ago drifts as the market
        regime shifts; restricting to the recent slice keeps the
        low/medium/high split matched to current conditions. Falls back to
        the full OOB set automatically if the recent slice has fewer than
        10 rows (e.g. a short training window). None (default) preserves
        the original whole-history behaviour.
        rf_kwargs: forwarded to the underlying RandomForestRegressor
        (n_estimators, random_state, n_jobs, etc. — no class_weight, since
        this is regression, not classification).
        """
        self.thresholds = thresholds
        self.class_names = class_names
        self.calibrate_thresholds = calibrate_thresholds
        self.calibration_recency_months = calibration_recency_months
        self.rf_kwargs = rf_kwargs

    def fit(self, X, risk_score, sample_months=None):
        """risk_score: the CONTINUOUS hybrid score (not the bucketed label).
        Fitting against the continuous target is the whole point of this
        class — see module docstring.

        sample_months: optional, one timestamp-like value per row of X,
        used only when calibration_recency_months is set, to restrict
        threshold calibration to the most recent slice of the training
        window (see __init__)."""
        rf_kwargs = dict(self.rf_kwargs)
        if self.calibrate_thresholds:
            rf_kwargs["oob_score"] = True
            rf_kwargs["bootstrap"] = True
        self.regressor_ = RandomForestRegressor(**rf_kwargs)
        self.regressor_.fit(X, risk_score)
        self.classes_ = np.array([0, 1, 2])
        self.feature_importances_ = self.regressor_.feature_importances_

        self.thresholds_ = self.thresholds
        if self.calibrate_thresholds and hasattr(self.regressor_, "oob_prediction_"):
            oob = self.regressor_.oob_prediction_
            # A handful of rows can lack OOB coverage with few trees/small n
            # (every tree happened to bootstrap them in) — drop those, not
            # the whole calibration.
            finite_mask = np.isfinite(oob)
            cal_mask = finite_mask

            if self.calibration_recency_months is not None and sample_months is not None:
                months = pd.to_datetime(np.asarray(sample_months))
                cutoff = months.max() - pd.DateOffset(months=self.calibration_recency_months)
                # `months >= cutoff` already returns a plain ndarray (a
                # DatetimeIndex compared against a scalar Timestamp does
                # NOT return another DatetimeIndex), so wrap with
                # np.asarray directly rather than calling .to_numpy() on
                # the comparison result, which doesn't have that method.
                recent_mask = np.asarray(months >= cutoff)
                combined_mask = finite_mask & recent_mask
                # Only use the recent slice if it actually has enough rows
                # to calibrate against; otherwise silently fall back to the
                # full OOB set rather than calibrating on too few points.
                if combined_mask.sum() >= 10:
                    cal_mask = combined_mask

            oob_cal = oob[cal_mask]
            if len(oob_cal) >= 10:
                self.thresholds_ = tuple(np.quantile(oob_cal, [1 / 3, 2 / 3]))
        return self

    def _bucket(self, scores):
        q1, q2 = self.thresholds_
        scores = np.asarray(scores)
        return np.where(scores <= q1, 0, np.where(scores <= q2, 1, 2))

    def predict(self, X):
        return self._bucket(self.regressor_.predict(X))

    def predict_proba(self, X):
        X = np.asarray(X)
        tree_preds = np.stack([t.predict(X) for t in self.regressor_.estimators_], axis=1)
        n_samples, n_trees = tree_preds.shape
        tree_buckets = self._bucket(tree_preds.reshape(-1)).reshape(n_samples, n_trees)
        probs = np.zeros((n_samples, 3))
        for c in range(3):
            probs[:, c] = (tree_buckets == c).mean(axis=1)
        return probs