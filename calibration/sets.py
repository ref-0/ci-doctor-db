# Trusted label sets for calibration (read by calib.py).
DISTRUST = {
    # Practice-based: the 'well-run' slice labels repos fast for their techniques, not a measured wait.
    'slice:well-run': 'labelled for practices, not a measured wait',
    # Label's own sample median disagrees with ours by >2x (different workflow or sample).
    'elixir-lang/elixir': 'label ~9 min, ours 24.4',
    'symfony/symfony': 'label ~34 min, ours 9.0',
    'godotengine/godot': 'label ~89 min, ours 17.1',
    'tox-dev/pre-commit-uv': 'label 15+ min runs, ours p50 4.0',
    # Slow label with no slow wait in the why.
    'feernandooff/kinuvo': '"slow" with a 10 min median at 212k lines; the why gives no reason',
    'functionalscript/functionalscript': '18 min at 616k lines is about the size curve; ambiguous',
}
# Labelled slow for failing runs, not for waiting: a reliability label, reported apart.
FAILING = {'silvertree2010/apollooffice', 'gastownhall/beads', 'solenopsisbot/decaf', 'pytest-dev/pytest-asyncio',
           'apple/swift-log', 'benhoyt/inih', 'go-sql-driver/mysql', 'apple/swift-http-types', 'jarro2783/cxxopts', 'gassius/botore'}
