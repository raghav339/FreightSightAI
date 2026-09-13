"""Ordinal risk classifier for FreightSight.

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
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.ensemble import RandomForestRegressor


class OrdinalRiskClassifier(BaseEstimator, ClassifierMixin):
    def __init__(self, thresholds, class_names=("low", "medium", "high"), calibrate_thresholds=True, **rf_kwargs):
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
        rf_kwargs: forwarded to the underlying RandomForestRegressor
        (n_estimators, random_state, n_jobs, etc. — no class_weight, since
        this is regression, not classification).
        """
        self.thresholds = thresholds
        self.class_names = class_names
        self.calibrate_thresholds = calibrate_thresholds
        self.rf_kwargs = rf_kwargs

    def fit(self, X, risk_score):
        """risk_score: the CONTINUOUS hybrid score (not the bucketed label).
        Fitting against the continuous target is the whole point of this
        class — see module docstring."""
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
            oob = oob[np.isfinite(oob)]
            if len(oob) >= 10:
                self.thresholds_ = tuple(np.quantile(oob, [1 / 3, 2 / 3]))
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