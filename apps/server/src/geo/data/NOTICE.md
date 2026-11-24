# cities15000.tsv

Contains data from [GeoNames](https://www.geonames.org), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): the towns of 15,000
people or more (`cities15000`), with their first-level region and country
names, trimmed to name, region, country, latitude and longitude.

Rebuilt by `apps/server/scripts/build-cities.mjs`; the download date is on the
file's first line. Read by `../cities.ts`, which the location tool uses to name
the nearest town without sending a position to anyone.
