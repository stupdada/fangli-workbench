"""Public, bounded errors; transport details never cross the HTTP boundary."""


class Problem(ValueError):
    status = 400


class Missing(Problem):
    status = 404


class Conflict(Problem):
    status = 409


class Forbidden(Problem):
    status = 403
